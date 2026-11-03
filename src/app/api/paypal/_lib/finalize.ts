import "server-only";
import { getDb } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { VerifiedCapture } from "./capture-validation";

export type FinalizeResult =
  | { status: "PAID"; orderId: string; pickupReference: string; idempotent: boolean }
  | { status: "PAYMENT_EXCEPTION"; orderId: string; reason: string }
  | { status: "NOT_FOUND" };

/**
 * Commit a verified PayPal capture and the reserved inventory in one serializable
 * database transaction. Replays are idempotent; mismatches preserve an exception
 * record and do not claim inventory was sold.
 */
export async function finalizeCapturedPayment(evidence: VerifiedCapture): Promise<FinalizeResult> {
  const db = getDb();
  const now = new Date();
  try {
    return await db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { paypalOrderId: evidence.orderId },
        include: {
          reservation: { include: { items: true, bundle: true } },
          items: true,
        },
      });
      if (!order) return { status: "NOT_FOUND" } as const;
      if (order.status === "PAID" || order.status === "FULFILLED") {
        return { status: "PAID", orderId: order.id, pickupReference: pickupReference(order.id), idempotent: true } as const;
      }

      const reservation = order.reservation;
      const itemTotal = reservation.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
      const orderItemTotal = order.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
      const originalTotal = order.items.reduce((sum, item) => sum + item.quantity * item.originalUnitPriceCents, 0);
      const units = reservation.items.reduce((sum, item) => sum + item.quantity, 0);
      const recoverableException = reservation.status === "PAYMENT_EXCEPTION"
        && ["CAPTURE_UNCERTAIN", "DATABASE_FINALIZATION_UNCERTAIN"].includes(reservation.failureCode ?? "");
      const reservationCanFinalize = reservation.status === "RESERVED"
        || reservation.status === "PAYMENT_APPROVED"
        || recoverableException;
      const safeReason = order.amountCents !== evidence.amountCents || itemTotal !== order.amountCents || orderItemTotal !== order.amountCents
        ? "PAYMENT_AMOUNT_MISMATCH"
        : !reservationCanFinalize
          ? "RESERVATION_NOT_ACTIVE"
          : reservation.status === "RESERVED" && reservation.expiresAt <= now
            ? "RESERVATION_EXPIRED"
            : evidence.currency !== "USD"
              ? "PAYMENT_CURRENCY_MISMATCH"
              : null;
      if (safeReason) {
        await markException(tx, order.id, reservation.id, safeReason, now);
        return { status: "PAYMENT_EXCEPTION", orderId: order.id, reason: safeReason } as const;
      }

      const lots = await tx.inventoryLot.findMany({
        where: { id: { in: reservation.items.map((item) => item.inventoryLotId) } },
      });
      const lotsById = new Map(lots.map((lot) => [lot.id, lot]));
      for (const item of reservation.items) {
        const lot = lotsById.get(item.inventoryLotId);
        if (
          !lot ||
          lot.quantityReserved < item.quantity ||
          lot.quantityOnHand - lot.quantitySold < item.quantity
        ) {
          await markException(tx, order.id, reservation.id, "RESERVED_STOCK_MISMATCH", now);
          return { status: "PAYMENT_EXCEPTION", orderId: order.id, reason: "RESERVED_STOCK_MISMATCH" } as const;
        }
      }

      for (const item of reservation.items) {
        const lot = lotsById.get(item.inventoryLotId)!;
        const changed = await tx.inventoryLot.updateMany({
          where: {
            id: lot.id,
            quantityReserved: { gte: item.quantity },
            quantityOnHand: lot.quantityOnHand,
            quantitySold: lot.quantitySold,
          },
          data: {
            quantityReserved: { decrement: item.quantity },
            quantitySold: { increment: item.quantity },
          },
        });
        if (changed.count !== 1) throw new Error("INVENTORY_FINALIZATION_CONFLICT");
      }

      await tx.paypalTransaction.create({
        data: {
          orderId: order.id,
          type: "CAPTURE",
          providerTransactionId: evidence.captureId,
          requestId: order.captureRequestId,
          status: "CAPTURED",
          amountCents: evidence.amountCents,
          currency: evidence.currency,
          responsePayload: {
            paypalOrderId: evidence.orderId,
            captureId: evidence.captureId,
            status: "COMPLETED",
            amountCents: evidence.amountCents,
            currency: evidence.currency,
          },
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "PAID",
          paymentStatus: "CAPTURED",
          paypalCaptureId: evidence.captureId,
          paidAt: now,
          paymentErrorCode: null,
          paymentErrorSummary: null,
        },
      });
      await tx.reservation.update({ where: { id: reservation.id }, data: { status: "PAID", paidAt: now } });
      await tx.bundle.update({ where: { id: reservation.bundleId }, data: { status: "PAID" } });
      await tx.impactMetric.create({
        data: {
          orderId: order.id,
          storeId: order.storeId,
          surplusUnitsPurchased: units,
          originalValueCents: originalTotal,
          paidValueCents: evidence.amountCents,
          savingsCents: Math.max(0, originalTotal - evidence.amountCents),
          methodologyVersion: "recorded-transaction-v1",
          isEstimate: false,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorType: "SYSTEM",
          action: "PAYMENT_CAPTURED",
          entityType: "Order",
          entityId: order.id,
          metadata: { captureId: evidence.captureId, amountCents: evidence.amountCents, currency: evidence.currency },
        },
      });
      return { status: "PAID", orderId: order.id, pickupReference: pickupReference(order.id), idempotent: false } as const;
    }, { isolationLevel: "Serializable" });
  } catch {
    await flagPaymentException(evidence.orderId, "DATABASE_FINALIZATION_UNCERTAIN");
    const order = await db.order.findUnique({ where: { paypalOrderId: evidence.orderId }, select: { id: true, status: true } });
    if (order?.status === "PAID" || order?.status === "FULFILLED") {
      return { status: "PAID", orderId: order.id, pickupReference: pickupReference(order.id), idempotent: true };
    }
    return order
      ? { status: "PAYMENT_EXCEPTION", orderId: order.id, reason: "DATABASE_FINALIZATION_UNCERTAIN" }
      : { status: "NOT_FOUND" };
  }
}
export async function flagPaymentException(paypalOrderId: string, code: string): Promise<void> {
  const db = getDb();
  const order = await db.order.findUnique({
    where: { paypalOrderId },
    select: { id: true, reservationId: true, status: true, reservation: { select: { status: true } } },
  });
  if (!order || order.status === "PAID" || order.status === "FULFILLED") return;
  await db.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id: order.id }, select: { status: true } });
    if (!current || current.status === "PAID" || current.status === "FULFILLED") return;
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: "PAYMENT_EXCEPTION",
        paymentStatus: "UNKNOWN",
        paymentErrorCode: /^[A-Z0-9_]{1,64}$/.test(code) ? code : "PAYMENT_UNCERTAIN",
        paymentErrorSummary: "PayPal reported or may have completed a capture, but the application could not safely confirm the final order state.",
      },
    });
    if (order.reservation.status !== "PAID" && order.reservation.status !== "FULFILLED") {
      await tx.reservation.update({
        where: { id: order.reservationId },
        data: {
          status: "PAYMENT_EXCEPTION",
          failureCode: /^[A-Z0-9_]{1,64}$/.test(code) ? code : "PAYMENT_UNCERTAIN",
          failureSummary: "Payment status needs reconciliation. Reserved stock was not released.",
        },
      });
    }
  }, { isolationLevel: "Serializable" });
}

export function pickupReference(orderId: string): string {
  return `RSQ-${orderId.slice(-8).toUpperCase()}`;
}

export function safeProviderErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  return typeof record.code === "string" && /^[A-Z0-9_]{1,80}$/i.test(record.code) ? record.code : undefined;
}

async function markException(
  tx: Prisma.TransactionClient,
  orderId: string,
  reservationId: string,
  reason: string,
  now: Date,
) {
  await tx.order.update({
    where: { id: orderId },
    data: {
      status: "PAYMENT_EXCEPTION",
      paymentStatus: "UNKNOWN",
      paymentErrorCode: reason,
      paymentErrorSummary: "Capture evidence did not match the reserved order. Manual reconciliation is required.",
      lastReconciledAt: now,
    },
  });
  await tx.reservation.update({
    where: { id: reservationId },
    data: { status: "PAYMENT_EXCEPTION", failureCode: reason, failureSummary: "Payment needs reconciliation; stock was not released." },
  });
}

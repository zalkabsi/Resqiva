import { NextResponse } from "next/server";
import { z } from "zod";
import { isSameOriginMutation, readSessionFromRequest } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { readJsonLimited, RequestReadError } from "@/lib/request";
import { createPayPalOrder, getPayPalOrder, PayPalApiError, paypalApprovalUrl } from "@/lib/paypal";
import { finalizeCapturedPayment, flagPaymentException } from "@/app/api/paypal/_lib/finalize";
import { verifyCompletedCapture, verifyPayPalOrderAmount } from "@/app/api/paypal/_lib/capture-validation";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_REQUEST_BYTES = 4 * 1024;

const requestSchema = z.object({
  reservationId: z.string().min(1).max(128),
}).strict();

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Cross-origin checkout request was rejected." }, { status: 403 });
  }
  const session = readSessionFromRequest(request);
  if (!session || session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "A signed customer demo session is required." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await readJsonLimited(request, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestReadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Provide a valid reservation ID." }, { status: 400 });
  }

  const db = getDb();
  const reservation = await db.reservation.findUnique({
    where: { id: parsed.data.reservationId },
    include: {
      items: { include: { inventoryLot: { include: { product: true } } } },
      bundle: true,
      store: true,
      order: true,
    },
  });
  if (!reservation || reservation.userId !== session.userId) {
    return NextResponse.json({ error: "Reservation was not found for this customer." }, { status: 404 });
  }
  if (!reservation.store.isDemo || !reservation.bundle.id) {
    return NextResponse.json({ error: "Checkout is limited to fictional demo inventory." }, { status: 409 });
  }
  if (reservation.store.currency !== "USD") {
    return NextResponse.json({ error: "PayPal Sandbox checkout currently supports USD demo stores only." }, { status: 409 });
  }

  const amountCents = reservation.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  if (
    amountCents <= 0 ||
    !Number.isSafeInteger(amountCents) ||
    amountCents !== reservation.bundle.totalCents ||
    reservation.items.length === 0
  ) {
    await db.reservation.update({
      where: { id: reservation.id },
      data: {
        status: "PAYMENT_EXCEPTION",
        failureCode: "RESERVATION_TOTAL_MISMATCH",
        failureSummary: "Stored reservation items did not match the saved bundle total; checkout was not started.",
      },
    });
    return NextResponse.json({ error: "The reserved items no longer match the saved total. Checkout was not started." }, { status: 409 });
  }
  if (
    reservation.status !== "RESERVED" ||
    reservation.expiresAt <= new Date()
  ) {
    return NextResponse.json({ error: "This reservation is no longer active. Build a new bundle and reserve again." }, { status: 409 });
  }

  const createRequestId = `resqiva-create-${reservation.id}`;
  let order = reservation.order;
  if (order && order.amountCents !== amountCents) {
    return NextResponse.json({ error: "The saved order amount does not match its reserved inventory." }, { status: 409 });
  }
  if (!order) {
    try {
      order = await db.order.create({
        data: {
          reservationId: reservation.id,
          userId: reservation.userId,
          storeId: reservation.storeId,
          pickupWindowId: reservation.pickupWindowId,
          status: "PENDING",
          paymentStatus: "CREATED",
          currency: "USD",
          amountCents,
          createRequestId,
          items: {
            create: reservation.items.map((item) => ({
              inventoryLotId: item.inventoryLotId,
              productNameSnapshot: item.inventoryLot.product.name,
              skuSnapshot: item.inventoryLot.product.sku,
              quantity: item.quantity,
              unitPriceCents: item.unitPriceCents,
              originalUnitPriceCents: item.originalUnitPriceCents,
            })),
          },
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      order = await db.order.findUnique({ where: { reservationId: reservation.id } });
      if (!order) return NextResponse.json({ error: "The checkout is already being prepared. Refresh and retry shortly." }, { status: 409 });
      if (order.amountCents !== amountCents) return NextResponse.json({ error: "The saved order amount does not match its reserved inventory." }, { status: 409 });
    }
  } else if (!order.createRequestId) {
    order = await db.order.update({ where: { id: order.id }, data: { createRequestId } });
  }

  if (order.paypalOrderId) {
    try {
      const remoteOrder = await getPayPalOrder(order.paypalOrderId);
      const matching = verifyPayPalOrderAmount(remoteOrder, {
        orderId: order.paypalOrderId,
        reservationId: reservation.id,
        amountCents,
      });
      if (!matching.valid) {
        return NextResponse.json({ error: "The existing PayPal order does not match this reservation. It needs reconciliation." }, { status: 409 });
      }
      if (remoteOrder.status === "COMPLETED") {
        const verification = verifyCompletedCapture(remoteOrder, {
          orderId: order.paypalOrderId,
          reservationId: reservation.id,
          amountCents,
        });
        if (!verification.valid) {
          await flagPaymentException(order.paypalOrderId, verification.reason);
          return NextResponse.json({ error: "PayPal completed an order that does not match this reservation. Reconciliation is required." }, { status: 409 });
        }
        const finalization = await finalizeCapturedPayment(verification.evidence);
        if (finalization.status === "PAID") {
          return NextResponse.json({ status: "PAID", orderId: finalization.orderId, pickupReference: finalization.pickupReference, idempotent: true });
        }
        return NextResponse.json({ status: "PAYMENT_EXCEPTION", error: "PayPal shows a completed payment that could not be matched to reserved inventory. Reconciliation is required." }, { status: 409 });
      }
      const approvalUrl = paypalApprovalUrl(remoteOrder);
      if (approvalUrl) {
        const persisted = await persistCreatedPayPalOrder(db, {
          orderId: order.id,
          reservationId: reservation.id,
          userId: session.userId,
          createRequestId: order.createRequestId ?? createRequestId,
          amountCents,
          paypalOrder: remoteOrder,
        });
        if (persisted !== "READY") {
          return NextResponse.json(
            { error: "The reservation changed while checkout status was being checked. No approval link was issued; the PayPal order remains saved for reconciliation." },
            { status: 409 },
          );
        }
        return NextResponse.json({ paypalOrderId: order.paypalOrderId, approvalUrl, status: "PENDING" });
      }
      return NextResponse.json({ error: "PayPal did not provide an approval link. The order is not paid." }, { status: 502 });
    } catch {
      return NextResponse.json({ error: "The existing PayPal Sandbox order could not be checked. Retry shortly." }, { status: 502 });
    }
  }

  const origin = new URL(request.url).origin;
  const returnUrl = new URL("/", origin);
  returnUrl.searchParams.set("reservationId", reservation.id);
  const cancelUrl = new URL("/", origin);
  cancelUrl.searchParams.set("cancel", "1");
  cancelUrl.searchParams.set("reservationId", reservation.id);

  try {
    const paypalOrder = await createPayPalOrder({
      reservation: { reservationId: reservation.id, trustedTotalCents: amountCents, status: "RESERVED" },
      idempotencyKey: createRequestId,
      returnUrl: returnUrl.toString(),
      cancelUrl: cancelUrl.toString(),
    });
    const matching = verifyPayPalOrderAmount(paypalOrder, {
      orderId: paypalOrder.id,
      reservationId: reservation.id,
      amountCents,
    });
    if (!matching.valid) {
      return NextResponse.json({ error: "PayPal created an order that did not match the reservation. It was not sent for approval." }, { status: 502 });
    }
    const persisted = await persistCreatedPayPalOrder(db, {
      orderId: order.id,
      reservationId: reservation.id,
      userId: session.userId,
      createRequestId,
      amountCents,
      paypalOrder,
    });
    if (persisted !== "READY") {
      return NextResponse.json(
        { error: "The reservation changed while checkout was being prepared. No approval link was issued; the PayPal order reference was saved for reconciliation." },
        { status: 409 },
      );
    }
    const approvalUrl = paypalApprovalUrl(paypalOrder);
    if (!approvalUrl) {
      await db.order.updateMany({
        where: { id: order.id, paypalOrderId: paypalOrder.id, status: "PENDING", paymentStatus: "CREATED" },
        data: { paymentErrorCode: "APPROVAL_LINK_MISSING", paymentErrorSummary: "PayPal did not return an approved Sandbox checkout URL." },
      });
      return NextResponse.json({ error: "PayPal did not return an approval link. The reservation is unpaid." }, { status: 502 });
    }
    return NextResponse.json({ paypalOrderId: paypalOrder.id, approvalUrl, status: "PENDING" });
  } catch (error) {
    if (error instanceof PayPalApiError && error.code?.toLowerCase() === "invalid_client") {
      return NextResponse.json({ error: "PayPal Sandbox credentials were rejected. No payment was created." }, { status: 502 });
    }
    return NextResponse.json(
      { error: "PayPal Sandbox checkout could not be created. No payment was recorded; retry while the reservation is active." },
      { status: 502 },
    );
  }
}

type PersistCreatedPayPalOrderInput = {
  orderId: string;
  reservationId: string;
  userId: string;
  createRequestId: string;
  amountCents: number;
  paypalOrder: { id: string; status: string };
};

type PersistCreatedPayPalOrderResult = "READY" | "NOT_READY" | "NOT_FOUND";

/**
 * Save provider evidence without ever reopening a reservation/order that
 * cancellation or expiry already closed. The reservation compare-and-set is
 * the linearization point for issuing the approval link.
 */
async function persistCreatedPayPalOrder(
  db: ReturnType<typeof getDb>,
  input: PersistCreatedPayPalOrderInput,
): Promise<PersistCreatedPayPalOrderResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const reservation = await tx.reservation.findUnique({
          where: { id: input.reservationId },
          select: { id: true, status: true, expiresAt: true },
        });
        const order = await tx.order.findUnique({
          where: { id: input.orderId },
          select: { id: true, status: true, paymentStatus: true, paypalOrderId: true },
        });
        if (!reservation || !order) return "NOT_FOUND" as const;

        const active = reservation.status === "RESERVED"
          && reservation.expiresAt > new Date()
          && order.status === "PENDING"
          && order.paymentStatus === "CREATED"
          && (!order.paypalOrderId || order.paypalOrderId === input.paypalOrder.id);

        let reservationClaimed = false;
        if (active) {
          const claim = await tx.reservation.updateMany({
            where: { id: reservation.id, status: "RESERVED", expiresAt: { gt: new Date() } },
            data: { status: "RESERVED" },
          });
          reservationClaimed = claim.count === 1;
        }

        let linked = order.paypalOrderId === input.paypalOrder.id;
        let newlyLinked = false;
        if (!order.paypalOrderId) {
          if (active && reservationClaimed) {
            const assignment = await tx.order.updateMany({
              where: {
                id: order.id,
                paypalOrderId: null,
                status: "PENDING",
                paymentStatus: "CREATED",
              },
              data: { paypalOrderId: input.paypalOrder.id },
            });
            newlyLinked = assignment.count === 1;
            linked = newlyLinked;
          }
          if (!linked) {
            // Preserve the remote order reference for operator reconciliation,
            // but never restore PENDING/CREATED after a cancellation or expiry.
            const evidenceLink = await tx.order.updateMany({
              where: { id: order.id, paypalOrderId: null },
              data: { paypalOrderId: input.paypalOrder.id },
            });
            newlyLinked = evidenceLink.count === 1;
            linked = newlyLinked;
          }
        }

        await tx.paypalTransaction.upsert({
          where: { providerTransactionId: input.paypalOrder.id },
          update: {},
          create: {
            orderId: order.id,
            type: "ORDER_CREATE",
            providerTransactionId: input.paypalOrder.id,
            requestId: order.paypalOrderId && order.paypalOrderId !== input.paypalOrder.id ? null : input.createRequestId,
            status: "CREATED",
            amountCents: input.amountCents,
            currency: "USD",
            responsePayload: {
              paypalOrderId: input.paypalOrder.id,
              status: input.paypalOrder.status,
              amountCents: input.amountCents,
              currency: "USD",
            },
          },
        });

        const ready = active && reservationClaimed && linked;
        if (newlyLinked) {
          await tx.auditEvent.create({
            data: {
              actorUserId: input.userId,
              actorType: "CUSTOMER",
              action: ready ? "PAYPAL_ORDER_CREATED" : "PAYPAL_ORDER_CREATED_WITHOUT_APPROVAL",
              entityType: "Order",
              entityId: order.id,
              metadata: {
                amountCents: input.amountCents,
                currency: "USD",
                reservationStatus: reservation.status,
                orderStatus: order.status,
              },
            },
          });
        }
        return ready ? "READY" as const : "NOT_READY" as const;
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

function isSerializationConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2034" || code === "40001";
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

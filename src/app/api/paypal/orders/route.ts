import { NextResponse } from "next/server";
import { z } from "zod";
import { isSameOriginMutation, readSessionFromRequest } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createPayPalOrder, getPayPalOrder, PayPalApiError, paypalApprovalUrl } from "@/lib/paypal";
import { finalizeCapturedPayment, flagPaymentException } from "@/app/api/paypal/_lib/finalize";
import { verifyCompletedCapture, verifyPayPalOrderAmount } from "@/app/api/paypal/_lib/capture-validation";

export const runtime = "nodejs";
export const maxDuration = 30;

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
    body = await request.json();
  } catch {
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
      if (approvalUrl) return NextResponse.json({ paypalOrderId: order.paypalOrderId, approvalUrl, status: "PENDING" });
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
    const approvalUrl = paypalApprovalUrl(paypalOrder);
    if (!approvalUrl) {
      await db.order.update({
        where: { id: order.id },
        data: { paymentErrorCode: "APPROVAL_LINK_MISSING", paymentErrorSummary: "PayPal did not return an approved Sandbox checkout URL." },
      });
      return NextResponse.json({ error: "PayPal did not return an approval link. The reservation is unpaid." }, { status: 502 });
    }

    await db.$transaction(async (tx) => {
      const wasAssigned = await tx.order.updateMany({
        where: { id: order.id, paypalOrderId: null },
        data: { paypalOrderId: paypalOrder.id, status: "PENDING", paymentStatus: "CREATED", paymentErrorCode: null, paymentErrorSummary: null },
      });
      const current = await tx.order.findUnique({ where: { id: order.id }, select: { paypalOrderId: true } });
      if (current?.paypalOrderId !== paypalOrder.id) throw new Error("PAYPAL_ORDER_LINK_CONFLICT");
      await tx.paypalTransaction.upsert({
        where: { providerTransactionId: paypalOrder.id },
        update: {},
        create: {
          orderId: order.id,
          type: "ORDER_CREATE",
          providerTransactionId: paypalOrder.id,
          requestId: createRequestId,
          status: "CREATED",
          amountCents,
          currency: "USD",
          responsePayload: { paypalOrderId: paypalOrder.id, status: paypalOrder.status, amountCents, currency: "USD" },
        },
      });
      if (wasAssigned.count === 1) {
        await tx.auditEvent.create({
          data: {
            actorUserId: session.userId,
            actorType: "CUSTOMER",
            action: "PAYPAL_ORDER_CREATED",
            entityType: "Order",
            entityId: order.id,
            metadata: { amountCents, currency: "USD" },
          },
        });
      }
    });
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

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

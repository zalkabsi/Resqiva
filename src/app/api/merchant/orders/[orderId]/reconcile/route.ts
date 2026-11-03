import { NextResponse } from "next/server";
import { verifyCompletedCapture } from "@/app/api/paypal/_lib/capture-validation";
import { finalizeCapturedPayment, flagPaymentException } from "@/app/api/paypal/_lib/finalize";
import { getPayPalOrder } from "@/lib/paypal";
import { authorizeDemoMerchant, sameOriginRequired } from "@/lib/merchant-auth";
import { getDb } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { releaseReservation } from "@/lib/reservations";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ orderId: string }> };

const recoverableReservationFailures = new Set([
  "CAPTURE_UNCERTAIN",
  "DATABASE_FINALIZATION_UNCERTAIN",
]);

/** Reads PayPal state and reconciles only previously saved, verified captures. */
export async function POST(request: Request, context: RouteContext) {
  if (!request.headers.get("origin")) {
    return NextResponse.json({ error: "Origin verification is required for reconciliation." }, { status: 403 });
  }
  const originError = sameOriginRequired(request);
  if (originError) return originError;

  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;
  if (authorization.context.role !== "MERCHANT_ADMIN") {
    return NextResponse.json({ error: "Only a demo merchant administrator can reconcile payment status." }, { status: 403 });
  }
  if (request.body) {
    return NextResponse.json({ error: "Reconciliation does not accept a request body." }, { status: 400 });
  }
  const rateLimit = checkRateLimit(`merchant-reconcile:${authorization.context.userId}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many reconciliation checks. Wait before checking again." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const { orderId } = await context.params;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(orderId)) {
    return NextResponse.json({ error: "Order reference is invalid." }, { status: 400 });
  }

  try {
    const db = getDb();
    const order = await db.order.findFirst({
      where: { id: orderId, store: { merchantId: authorization.context.merchantId, isDemo: true } },
      select: {
        id: true,
        reservationId: true,
        status: true,
        paymentStatus: true,
        amountCents: true,
        currency: true,
        paypalOrderId: true,
        reservation: { select: { status: true, failureCode: true, expiresAt: true } },
      },
    });
    if (!order) return NextResponse.json({ error: "Order was not found for this demo merchant." }, { status: 404 });

    if (order.status === "PAID" || order.status === "FULFILLED") {
      return NextResponse.json({ status: order.status, paymentStatus: "CAPTURED", idempotent: true });
    }
    if (!order.paypalOrderId) {
      return NextResponse.json({ error: "This saved order has no PayPal Sandbox reference to reconcile." }, { status: 409 });
    }

    // Record the attempt without changing payment or stock state. The status
    // compare-and-set prevents querying an order that changed during lookup.
    const attempt = await db.order.updateMany({
      where: {
        id: order.id,
        paypalOrderId: order.paypalOrderId,
        status: order.status,
        paymentStatus: order.paymentStatus,
      },
      data: { lastReconciledAt: new Date() },
    });
    if (attempt.count !== 1) {
      return NextResponse.json({ error: "Order status changed. Refresh and reconcile its current state." }, { status: 409 });
    }

    let providerOrder;
    try {
      providerOrder = await getPayPalOrder(order.paypalOrderId);
    } catch {
      return NextResponse.json(
        { error: "PayPal Sandbox status could not be checked. The saved order and reserved inventory remain unchanged." },
        { status: 502 },
      );
    }

    if (providerOrder.status !== "COMPLETED") {
      if (providerOrder.status === "VOIDED") {
        // Do not infer release from the earlier status lookup alone. The
        // shared helper re-reads the saved state, checks a fresh PayPal status,
        // and compare-and-sets the reservation/order before releasing stock.
        const release = await releaseReservation(order.reservationId, "CANCELLED", authorization.context.userId, "MERCHANT");
        if (release === "released") {
          return NextResponse.json({
            status: "CANCELLED",
            paymentStatus: "FAILED",
            finalized: false,
            released: true,
            idempotent: false,
          });
        }
        if (release === "already_final") {
          const latest = await db.reservation.findUnique({
            where: { id: order.reservationId },
            select: { status: true, releasedAt: true },
          });
          if (latest?.releasedAt && (latest.status === "CANCELLED" || latest.status === "EXPIRED")) {
            return NextResponse.json({
              status: latest.status,
              paymentStatus: "FAILED",
              finalized: false,
              released: true,
              idempotent: true,
            });
          }
        }
        return NextResponse.json({
          status: "VOIDED",
          paymentStatus: order.paymentStatus,
          finalized: false,
          released: false,
          held: true,
        });
      }
      const knownStatuses = new Set(["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED", "VOIDED"]);
      const status = knownStatuses.has(providerOrder.status) ? providerOrder.status : "UNKNOWN";
      return NextResponse.json({ status, paymentStatus: order.paymentStatus, finalized: false });
    }

    const verification = order.currency === "USD"
      ? verifyCompletedCapture(providerOrder, {
        orderId: order.paypalOrderId,
        reservationId: order.reservationId,
        amountCents: order.amountCents,
      })
      : { valid: false as const, reason: "AMOUNT_MISMATCH" as const };

    if (!verification.valid) {
      await flagPaymentException(order.paypalOrderId, `RECONCILIATION_${verification.reason}`);
      return NextResponse.json(
        { status: "PAYMENT_EXCEPTION", error: "PayPal reports a completed order, but its captured details do not match the saved order. Inventory remains held for review." },
        { status: 409 },
      );
    }

    const closedReservation = order.status === "CANCELLED"
      || order.status === "EXPIRED"
      || order.reservation.status === "CANCELLED"
      || order.reservation.status === "EXPIRED"
      || (order.reservation.status === "RESERVED" && order.reservation.expiresAt <= new Date());
    if (closedReservation) {
      await flagPaymentException(order.paypalOrderId, "LATE_CAPTURE_AFTER_RESERVATION_CLOSED");
      return NextResponse.json(
        { status: "PAYMENT_EXCEPTION", error: "PayPal reports a capture after the reservation closed. Inventory was not committed; operator review is required." },
        { status: 409 },
      );
    }

    const eligibleForFinalization = (
      order.status === "PENDING" && order.reservation.status === "RESERVED" && order.paymentStatus === "CREATED"
    ) || (
      order.status === "PAYMENT_APPROVED"
      && ["RESERVED", "PAYMENT_APPROVED"].includes(order.reservation.status)
      && order.paymentStatus === "APPROVED"
    ) || (
      order.status === "PAYMENT_EXCEPTION"
      && order.paymentStatus === "UNKNOWN"
      && order.reservation.status === "PAYMENT_EXCEPTION"
      && recoverableReservationFailures.has(order.reservation.failureCode ?? "")
    );
    if (!eligibleForFinalization) {
      await flagPaymentException(order.paypalOrderId, "RECONCILIATION_STATE_MISMATCH");
      return NextResponse.json(
        { status: "PAYMENT_EXCEPTION", error: "The saved order state is not eligible for automatic finalization. Inventory remains held for review." },
        { status: 409 },
      );
    }

    const finalized = await finalizeCapturedPayment(verification.evidence);
    if (finalized.status === "PAID") {
      return NextResponse.json({
        status: "PAID",
        paymentStatus: "CAPTURED",
        pickupReference: finalized.pickupReference,
        idempotent: finalized.idempotent,
      });
    }
    if (finalized.status === "NOT_FOUND") {
      return NextResponse.json({ error: "The verified PayPal order no longer matches a saved Resqiva order." }, { status: 404 });
    }
    return NextResponse.json(
      { status: "PAYMENT_EXCEPTION", error: "PayPal capture was verified, but the saved reservation cannot safely be finalized. Inventory remains held for review." },
      { status: 409 },
    );
  } catch {
    return NextResponse.json({ error: "Order reconciliation could not be completed." }, { status: 503 });
  }
}

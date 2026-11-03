import { NextResponse } from "next/server";
import { verifyCompletedCapture } from "@/app/api/paypal/_lib/capture-validation";
import { finalizeCapturedPayment, flagPaymentException } from "@/app/api/paypal/_lib/finalize";
import { getPayPalOrder } from "@/lib/paypal";
import { getDb } from "@/lib/db";
import { isSameOriginMutation, readSessionFromRequest } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { ReservationError, releaseReservation } from "@/lib/reservations";

export const runtime = "nodejs";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ reservationId: string }> };

const recoverableReservationFailures = new Set([
  "CAPTURE_UNCERTAIN",
  "DATABASE_FINALIZATION_UNCERTAIN",
]);

/** Reconcile only a saved customer reservation; this route never captures or refunds. */
export async function POST(request: Request, context: RouteContext) {
  if (!request.headers.get("origin") || !isSameOriginMutation(request)) {
    return NextResponse.json({ error: "A same-origin request is required to reconcile this reservation." }, { status: 403 });
  }
  const session = readSessionFromRequest(request);
  if (!session || session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "A signed customer session is required to reconcile this reservation." }, { status: 401 });
  }
  if (request.body) {
    return NextResponse.json({ error: "Reconciliation does not accept a request body." }, { status: 400 });
  }

  const rateLimit = checkRateLimit(`customer-reconcile:${session.userId}`, 10, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many reconciliation checks. Wait before checking again." },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } },
    );
  }

  const { reservationId } = await context.params;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(reservationId)) {
    return NextResponse.json({ error: "Reservation reference is invalid." }, { status: 400 });
  }

  try {
    const db = getDb();
    const order = await db.order.findFirst({
      where: {
        reservationId,
        userId: session.userId,
        reservation: { userId: session.userId },
      },
      select: {
        id: true,
        reservationId: true,
        status: true,
        paymentStatus: true,
        amountCents: true,
        currency: true,
        paypalOrderId: true,
        reservation: { select: { id: true, status: true, failureCode: true, expiresAt: true } },
      },
    });
    if (!order) return NextResponse.json({ error: "The saved reservation order could not be found." }, { status: 404 });

    if (order.status === "PAID" || order.status === "FULFILLED") {
      return NextResponse.json({ status: order.status, paymentStatus: "CAPTURED", idempotent: true });
    }
    if (!order.paypalOrderId) {
      return NextResponse.json({ error: "This reservation has no saved PayPal Sandbox order to reconcile." }, { status: 409 });
    }

    let providerOrder;
    try {
      providerOrder = await getPayPalOrder(order.paypalOrderId);
    } catch {
      return NextResponse.json(
        { error: "PayPal Sandbox status could not be checked. The reservation and inventory remain unchanged." },
        { status: 502 },
      );
    }

    if (providerOrder.status === "VOIDED") {
      const released = await releaseReservation(reservationId, "CANCELLED", session.userId);
      if (released === "not_releasable") {
        return NextResponse.json(
          { error: "The reservation could not be released safely. Its inventory remains held for reconciliation." },
          { status: 409 },
        );
      }
      if (released === "released") return NextResponse.json({ status: "CANCELLED", released: true });

      const latest = await db.reservation.findUnique({ where: { id: reservationId }, select: { status: true } });
      const terminalStatus = latest?.status ?? order.reservation.status;
      const wasReleased = terminalStatus === "CANCELLED" || terminalStatus === "EXPIRED";
      return NextResponse.json({
        status: terminalStatus,
        released: wasReleased,
        idempotent: wasReleased,
      });
    }

    if (providerOrder.status !== "COMPLETED") {
      const knownStatuses = new Set(["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"]);
      const status = knownStatuses.has(providerOrder.status) ? providerOrder.status : "UNKNOWN";
      return NextResponse.json({ status, paymentStatus: order.paymentStatus, released: false, finalized: false });
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
        { status: "PAYMENT_EXCEPTION", error: "PayPal reports a completed payment, but the saved order details do not match. Inventory remains held for review." },
        { status: 409 },
      );
    }

    const reservationClosed = order.status === "CANCELLED"
      || order.status === "EXPIRED"
      || order.reservation.status === "CANCELLED"
      || order.reservation.status === "EXPIRED"
      || (order.reservation.status === "RESERVED" && order.reservation.expiresAt <= new Date());
    if (reservationClosed) {
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
        { status: "PAYMENT_EXCEPTION", error: "The saved reservation state is not eligible for automatic finalization. Inventory remains held for review." },
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
      return NextResponse.json({ error: "The verified PayPal order no longer matches a saved Resqiva reservation." }, { status: 404 });
    }
    return NextResponse.json(
      { status: "PAYMENT_EXCEPTION", error: "PayPal capture was verified, but the reservation cannot safely be finalized. Inventory remains held for review." },
      { status: 409 },
    );
  } catch (error) {
    if (error instanceof ReservationError && error.code === "RESERVATION_NOT_FOUND") {
      return NextResponse.json({ error: "The saved reservation could not be found." }, { status: 404 });
    }
    return NextResponse.json({ error: "Reservation reconciliation could not be completed." }, { status: 503 });
  }
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { isSameOriginMutation, readSessionFromRequest } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { capturePayPalOrder, getPayPalOrder, PayPalApiError } from "@/lib/paypal";
import { finalizeCapturedPayment, flagPaymentException, pickupReference } from "@/app/api/paypal/_lib/finalize";
import { verifyCompletedCapture, verifyPayPalOrderAmount } from "@/app/api/paypal/_lib/capture-validation";
import { claimReservationForCapture } from "@/lib/reservations";
import { readJsonLimited, RequestReadError } from "@/lib/request";

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_REQUEST_BYTES = 4 * 1024;

const requestSchema = z.object({ reservationId: z.string().min(1).max(128) }).strict();

type RouteContext = { params: Promise<{ paypalOrderId: string }> };

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Cross-origin payment confirmation was rejected." }, { status: 403 });
  }
  const session = readSessionFromRequest(request);
  if (!session || session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "A signed customer demo session is required." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await readJsonLimited(request, MAX_REQUEST_BYTES);
  } catch (error) {
    const tooLarge = error instanceof RequestReadError && error.status === 413;
    return NextResponse.json({ error: tooLarge ? "Request body is too large." : "Request body must be valid JSON." }, { status: tooLarge ? 413 : 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Provide the reservation reference returned by Resqiva." }, { status: 400 });

  const { paypalOrderId } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(paypalOrderId)) {
    return NextResponse.json({ error: "Invalid PayPal order reference." }, { status: 400 });
  }

  const db = getDb();
  const order = await db.order.findUnique({
    where: { paypalOrderId },
    include: {
      reservation: { include: { items: true, bundle: true } },
      items: true,
    },
  });
  if (!order || order.reservationId !== parsed.data.reservationId || order.userId !== session.userId) {
    return NextResponse.json({ error: "This PayPal order was not found for the supplied customer reservation." }, { status: 404 });
  }
  if (order.status === "PAID" || order.status === "FULFILLED") {
    return NextResponse.json({ status: "PAID", orderId: order.id, pickupReference: pickupReference(order.id), idempotent: true });
  }

  let providerOrder;
  try {
    providerOrder = await getPayPalOrder(paypalOrderId);
  } catch (error) {
    const code = error instanceof PayPalApiError ? error.code : undefined;
    return NextResponse.json(
      { error: code === "invalid_client" ? "PayPal Sandbox credentials were rejected. No capture was confirmed." : "PayPal Sandbox order status could not be checked. No paid status was recorded; retry after checking the order." },
      { status: 502 },
    );
  }

  if (providerOrder.status === "COMPLETED") {
    const verification = verifyCompletedCapture(providerOrder, {
      orderId: paypalOrderId,
      reservationId: order.reservationId,
      amountCents: order.amountCents,
    });
    if (!verification.valid) {
      await flagPaymentException(paypalOrderId, verification.reason);
      return NextResponse.json({ error: "PayPal reports a completed order, but its capture does not match the saved reservation. The order needs reconciliation." }, { status: 409 });
    }
    const finalized = await finalizeCapturedPayment(verification.evidence);
    return finalizationResponse(finalized);
  }

  const remoteAmount = verifyPayPalOrderAmount(providerOrder, {
    orderId: paypalOrderId,
    reservationId: order.reservationId,
    amountCents: order.amountCents,
  });
  if (!remoteAmount.valid) {
    await flagPaymentException(paypalOrderId, remoteAmount.reason);
    return NextResponse.json({ error: "PayPal order amount or reservation reference does not match. Capture was not requested." }, { status: 409 });
  }

  const reservation = order.reservation;
  const retryableException = reservation.status === "PAYMENT_EXCEPTION"
    && ["CAPTURE_UNCERTAIN", "DATABASE_FINALIZATION_UNCERTAIN"].includes(reservation.failureCode ?? "");
  const reservationCanCapture = reservation.status === "RESERVED" || reservation.status === "PAYMENT_APPROVED" || retryableException;
  if (!reservationCanCapture || (reservation.status === "RESERVED" && reservation.expiresAt <= new Date())) {
    return NextResponse.json({ error: "The reservation is cancelled, expired, or under reconciliation. No new capture was requested." }, { status: 409 });
  }
  if (providerOrder.status !== "APPROVED") {
    return NextResponse.json({ error: "PayPal has not confirmed buyer approval. No capture was requested." }, { status: 409 });
  }

  const itemTotal = reservation.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
  if (itemTotal !== order.amountCents || order.amountCents !== reservation.bundle.totalCents) {
    await flagPaymentException(paypalOrderId, "RESERVATION_TOTAL_MISMATCH");
    return NextResponse.json({ error: "The saved reservation total does not match its inventory lines. Capture was not requested." }, { status: 409 });
  }
  const lotIds = reservation.items.map((item) => item.inventoryLotId);
  const lots = await db.inventoryLot.findMany({ where: { id: { in: lotIds } } });
  const lotsById = new Map(lots.map((lot) => [lot.id, lot]));
  if (reservation.items.some((item) => (lotsById.get(item.inventoryLotId)?.quantityReserved ?? 0) < item.quantity)) {
    await flagPaymentException(paypalOrderId, "RESERVED_STOCK_MISMATCH");
    return NextResponse.json({ error: "The reservation no longer holds all of its stock. Capture was not requested and the order needs review." }, { status: 409 });
  }

  let claim: Awaited<ReturnType<typeof claimReservationForCapture>>;
  try {
    claim = await claimReservationForCapture(order.id, reservation.id);
  } catch {
    // No PayPal capture request is sent unless the local compare-and-set claim
    // completes. A timeout here is safe to retry with the same idempotency key.
    return NextResponse.json({ error: "The reservation could not be claimed for capture. No capture was requested; refresh the order status before retrying." }, { status: 503 });
  }
  if (claim !== "claimed") {
    return NextResponse.json({ error: "The reservation was cancelled, expired, or changed before capture could start. No capture was requested." }, { status: claim === "not_found" ? 404 : 409 });
  }

  const captureRequestId = order.captureRequestId ?? `resqiva-capture-${order.id}`;

  let captured;
  try {
    captured = await capturePayPalOrder(paypalOrderId, captureRequestId);
  } catch (error) {
    try {
      const retryStatus = await getPayPalOrder(paypalOrderId);
      if (retryStatus.status === "COMPLETED") {
        const verification = verifyCompletedCapture(retryStatus, {
          orderId: paypalOrderId,
          reservationId: reservation.id,
          amountCents: order.amountCents,
        });
        if (!verification.valid) {
          await flagPaymentException(paypalOrderId, verification.reason);
          return NextResponse.json({ error: "PayPal completed capture could not be matched to the saved total; reconciliation is required." }, { status: 409 });
        }
        return finalizationResponse(await finalizeCapturedPayment(verification.evidence));
      }
      if (error instanceof PayPalApiError && error.status >= 400 && error.status < 500) {
        await db.order.updateMany({
          where: {
            id: order.id,
            status: "PAYMENT_APPROVED",
            paymentStatus: "APPROVED",
            paymentErrorCode: "CAPTURE_IN_PROGRESS",
          },
          data: { paymentErrorCode: error.code ?? "CAPTURE_REJECTED", paymentErrorSummary: "PayPal rejected this capture attempt; check the provider order before retrying." },
        });
        return NextResponse.json({ error: "PayPal did not complete the capture. The order is not marked paid; retry or cancel after checking its status." }, { status: 502 });
      }
    } catch {
      // A failed status lookup leaves the capture outcome uncertain. Preserve the reservation for reconciliation.
    }
    await flagPaymentException(paypalOrderId, "CAPTURE_UNCERTAIN");
    return NextResponse.json({ error: "PayPal capture status is uncertain. Inventory remains held and the order needs reconciliation before retry." }, { status: 502 });
  }

  const verification = verifyCompletedCapture(captured, {
    orderId: paypalOrderId,
    reservationId: reservation.id,
    amountCents: order.amountCents,
  });
  if (!verification.valid) {
    await flagPaymentException(paypalOrderId, verification.reason);
    return NextResponse.json({ error: "PayPal did not return a completed capture matching the reserved total. The order needs reconciliation." }, { status: 409 });
  }
  return finalizationResponse(await finalizeCapturedPayment(verification.evidence));
}

function finalizationResponse(result: Awaited<ReturnType<typeof finalizeCapturedPayment>>) {
  if (result.status === "PAID") {
    return NextResponse.json({ status: "PAID", orderId: result.orderId, pickupReference: result.pickupReference, idempotent: result.idempotent });
  }
  if (result.status === "NOT_FOUND") {
    return NextResponse.json({ error: "PayPal capture could not be matched to a Resqiva order." }, { status: 404 });
  }
  return NextResponse.json({ status: "PAYMENT_EXCEPTION", error: "PayPal completed or may have completed payment, but the inventory/order transaction needs reconciliation. Do not retry checkout." }, { status: 409 });
}

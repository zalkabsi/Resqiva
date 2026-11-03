import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  getPayPalOrder,
  paypalWebhookHeaders,
  verifyPayPalWebhookSignature,
} from "@/lib/paypal";
import {
  finalizeCapturedPayment,
  flagPaymentException,
} from "@/app/api/paypal/_lib/finalize";
import { verifyCompletedCapture } from "@/app/api/paypal/_lib/capture-validation";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) {
    return NextResponse.json({ error: "Webhook body exceeds the allowed size." }, { status: 413 });
  }
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Webhook body must be valid JSON." }, { status: 400 });
  }
  if (!isRecord(event) || typeof event.id !== "string" || typeof event.event_type !== "string") {
    return NextResponse.json({ error: "Webhook event is missing its required identifiers." }, { status: 400 });
  }
  if (!process.env.PAYPAL_WEBHOOK_ID?.trim()) {
    return NextResponse.json({ error: "PayPal webhook verification is not configured." }, { status: 503 });
  }

  let verified: boolean;
  try {
    verified = await verifyPayPalWebhookSignature(paypalWebhookHeaders(request.headers), event);
  } catch {
    return NextResponse.json({ error: "PayPal webhook signature could not be verified. The event was not processed." }, { status: 503 });
  }
  if (!verified) return NextResponse.json({ error: "PayPal webhook signature is invalid." }, { status: 401 });

  const eventId = event.id;
  const eventType = event.event_type;
  const resource = asRecord(event.resource);
  const resourceId = resource && typeof resource.id === "string" ? resource.id : undefined;
  const paypalOrderId = readOrderId(eventType, resource);
  const db = getDb();

  let stored = await db.webhookEvent.findUnique({ where: { eventId } });
  if (stored?.status === "PROCESSED") {
    return NextResponse.json({ received: true, duplicate: true, processed: true });
  }
  const safePayload = {
    id: eventId,
    eventType,
    resourceId: resourceId ?? null,
    orderId: paypalOrderId ?? null,
    createTime: typeof event.create_time === "string" ? event.create_time : null,
    amount: safeAmount(resource),
  };
  if (!stored) {
    try {
      stored = await db.webhookEvent.create({
        data: {
          eventId,
          eventType,
          providerResourceId: resourceId,
          verified: true,
          status: "VERIFIED",
          payload: safePayload,
        },
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      stored = await db.webhookEvent.findUnique({ where: { eventId } });
      if (stored?.status === "PROCESSED") return NextResponse.json({ received: true, duplicate: true, processed: true });
      if (!stored) return NextResponse.json({ error: "Webhook event could not be recorded." }, { status: 503 });
    }
  } else {
    stored = await db.webhookEvent.update({
      where: { eventId },
      data: { verified: true, status: "VERIFIED", attemptCount: { increment: 1 }, lastAttemptAt: new Date(), failureSummary: null, payload: safePayload },
    });
  }

  if (!paypalOrderId) {
    await db.webhookEvent.update({
      where: { eventId },
      data: { status: "PROCESSED", processedAt: new Date(), lastAttemptAt: new Date(), failureSummary: null },
    });
    return NextResponse.json({ received: true, processed: true, ignored: true });
  }

  const order = await db.order.findUnique({
    where: { paypalOrderId },
    include: { reservation: { include: { items: true } } },
  });
  if (!order) {
    await db.webhookEvent.update({
      where: { eventId },
      data: {
        status: "FAILED",
        providerResourceId: resourceId,
        lastAttemptAt: new Date(),
        failureSummary: "Verified PayPal event has no matching local order.",
      },
    });
    return NextResponse.json({ received: true, processed: false, message: "No matching local order." }, { status: 202 });
  }

  await db.webhookEvent.update({ where: { eventId }, data: { orderId: order.id, providerResourceId: resourceId, lastAttemptAt: new Date() } });

  try {
    if (eventType === "CHECKOUT.ORDER.APPROVED") {
      const reservation = order.reservation;
      if (reservation.status === "RESERVED" && reservation.expiresAt > new Date()) {
        await db.$transaction([
          db.order.updateMany({
            where: { id: order.id, status: { in: ["PENDING", "PAYMENT_APPROVED"] } },
            data: { status: "PAYMENT_APPROVED", paymentStatus: "APPROVED" },
          }),
          db.reservation.updateMany({
            where: { id: reservation.id, status: "RESERVED" },
            data: { status: "PAYMENT_APPROVED", paymentApprovedAt: new Date() },
          }),
        ]);
      } else if (reservation.status !== "PAID" && reservation.status !== "FULFILLED") {
        await flagPaymentException(paypalOrderId, "APPROVAL_AFTER_RESERVATION_CLOSED");
      }
    } else if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
      const providerOrder = await getPayPalOrder(paypalOrderId);
      const verification = verifyCompletedCapture(providerOrder, {
        orderId: paypalOrderId,
        reservationId: order.reservationId,
        amountCents: order.amountCents,
      });
      if (!verification.valid) {
        await flagPaymentException(paypalOrderId, verification.reason);
        await db.webhookEvent.update({
          where: { eventId },
          data: { status: "FAILED", lastAttemptAt: new Date(), failureSummary: "Provider capture did not match the saved order; payment needs reconciliation." },
        });
        return NextResponse.json({ error: "Verified capture did not match the order." }, { status: 409 });
      }
      const result = await finalizeCapturedPayment(verification.evidence);
      if (result.status !== "PAID") {
        await db.webhookEvent.update({
          where: { eventId },
          data: { status: "FAILED", lastAttemptAt: new Date(), failureSummary: "Capture finalization needs reconciliation." },
        });
        return NextResponse.json({ error: "Verified capture could not be reconciled to inventory." }, { status: 503 });
      }
    } else if (eventType === "PAYMENT.CAPTURE.DENIED") {
      await db.$transaction([
        db.order.updateMany({
          where: { id: order.id, status: { notIn: ["PAID", "FULFILLED"] } },
          data: { status: "PAYMENT_EXCEPTION", paymentStatus: "DECLINED", paymentErrorCode: "CAPTURE_DENIED", paymentErrorSummary: "PayPal denied the capture; merchant reconciliation is required." },
        }),
        db.reservation.updateMany({
          where: { id: order.reservationId, status: { notIn: ["PAID", "FULFILLED"] } },
          data: { status: "PAYMENT_EXCEPTION", failureCode: "CAPTURE_DENIED", failureSummary: "PayPal denied capture. Reserved stock remains held pending review." },
        }),
      ]);
    } else if (eventType === "PAYMENT.CAPTURE.REFUNDED" || eventType === "PAYMENT.CAPTURE.REVERSED") {
      await db.order.updateMany({
        where: { id: order.id, status: { not: "FULFILLED" } },
        data: { status: "PAYMENT_EXCEPTION", paymentStatus: "REFUNDED", paymentErrorCode: "PAYMENT_REVERSED", paymentErrorSummary: "PayPal reported a reversal or refund; order requires review." },
      });
      await db.reservation.updateMany({
        where: { id: order.reservationId, status: { not: "FULFILLED" } },
        data: { status: "PAYMENT_EXCEPTION", failureCode: "PAYMENT_REVERSED", failureSummary: "PayPal reported a reversal or refund; order requires review." },
      });
    }

    await db.webhookEvent.update({
      where: { eventId },
      data: { status: "PROCESSED", processedAt: new Date(), lastAttemptAt: new Date(), failureSummary: null },
    });
    return NextResponse.json({ received: true, processed: true });
  } catch {
    await db.webhookEvent.update({
      where: { eventId },
      data: { status: "FAILED", lastAttemptAt: new Date(), attemptCount: { increment: 1 }, failureSummary: "Webhook processing failed; PayPal may retry delivery." },
    });
    return NextResponse.json({ error: "Verified PayPal event could not be processed. The application will retry reconciliation." }, { status: 503 });
  }
}

function readOrderId(eventType: string, resource: Record<string, unknown> | null): string | undefined {
  if (!resource) return undefined;
  if (eventType.startsWith("CHECKOUT.ORDER.") && typeof resource.id === "string") return resource.id;
  const supplementary = asRecord(resource.supplementary_data);
  const related = supplementary && asRecord(supplementary.related_ids);
  const orderId = related?.order_id;
  return typeof orderId === "string" ? orderId : undefined;
}

function safeAmount(resource: Record<string, unknown> | null): { value: string; currency: string } | null {
  const amount = resource && asRecord(resource.amount);
  if (typeof amount?.value !== "string" || typeof amount.currency_code !== "string") return null;
  return { value: amount.value.slice(0, 24), currency: amount.currency_code.slice(0, 8) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isUniqueConflict(error: unknown): boolean {
  return isRecord(error) && error.code === "P2002";
}

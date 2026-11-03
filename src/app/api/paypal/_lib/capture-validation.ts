import { centsToPayPalAmount, type PayPalOrder } from "@/lib/paypal";

export interface VerifiedCapture {
  orderId: string;
  captureId: string;
  amountCents: number;
  currency: "USD";
}

export type CaptureVerification =
  | { valid: true; evidence: VerifiedCapture }
  | { valid: false; reason: "ORDER_NOT_COMPLETED" | "UNIT_MISMATCH" | "CAPTURE_MISMATCH" | "AMOUNT_MISMATCH" };

export type OrderVerification =
  | { valid: true }
  | { valid: false; reason: "ORDER_ID_MISMATCH" | "UNIT_MISMATCH" | "AMOUNT_MISMATCH" };

/** Validate a non-captured remote order before redirecting or requesting capture. */
export function verifyPayPalOrderAmount(
  order: PayPalOrder,
  expected: { orderId: string; reservationId: string; amountCents: number },
): OrderVerification {
  if (order.id !== expected.orderId) return { valid: false, reason: "ORDER_ID_MISMATCH" };
  const units = order.purchase_units;
  if (!units || units.length !== 1 || units[0].reference_id !== expected.reservationId) {
    return { valid: false, reason: "UNIT_MISMATCH" };
  }
  const amount = asRecord(units[0].amount);
  if (
    !Number.isSafeInteger(expected.amountCents) ||
    expected.amountCents <= 0 ||
    amount?.currency_code !== "USD" ||
    amount?.value !== centsToPayPalAmount(expected.amountCents)
  ) {
    return { valid: false, reason: "AMOUNT_MISMATCH" };
  }
  return { valid: true };
}

/** Require PayPal's completed order, its one expected purchase unit, and exact capture cents. */
export function verifyCompletedCapture(
  order: PayPalOrder,
  expected: { orderId: string; reservationId: string; amountCents: number },
): CaptureVerification {
  if (order.id !== expected.orderId || order.status !== "COMPLETED") {
    return { valid: false, reason: "ORDER_NOT_COMPLETED" };
  }
  const units = order.purchase_units;
  if (!units || units.length !== 1 || units[0].reference_id !== expected.reservationId) {
    return { valid: false, reason: "UNIT_MISMATCH" };
  }
  const unit = units[0];
  const amount = asRecord(unit.amount);
  const payments = asRecord(unit.payments);
  const captures = payments && Array.isArray(payments.captures) ? payments.captures : [];
  if (captures.length !== 1) return { valid: false, reason: "CAPTURE_MISMATCH" };
  const capture = asRecord(captures[0]);
  const captureAmount = capture && asRecord(capture.amount);
  if (
    !capture ||
    typeof capture.id !== "string" ||
    capture.status !== "COMPLETED" ||
    !captureAmount ||
    captureAmount.currency_code !== "USD" ||
    typeof captureAmount.value !== "string"
  ) {
    return { valid: false, reason: "CAPTURE_MISMATCH" };
  }
  if (
    !Number.isSafeInteger(expected.amountCents) ||
    expected.amountCents <= 0 ||
    amount?.currency_code !== "USD" ||
    amount?.value !== centsToPayPalAmount(expected.amountCents) ||
    captureAmount.value !== centsToPayPalAmount(expected.amountCents)
  ) {
    return { valid: false, reason: "AMOUNT_MISMATCH" };
  }
  return {
    valid: true,
    evidence: {
      orderId: order.id,
      captureId: capture.id,
      amountCents: expected.amountCents,
      currency: "USD",
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

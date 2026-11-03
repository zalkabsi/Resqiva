import { describe, expect, it } from "vitest";
import { verifyCompletedCapture, verifyPayPalOrderAmount } from "@/app/api/paypal/_lib/capture-validation";
import type { PayPalOrder } from "@/lib/paypal";

const completedOrder: PayPalOrder = {
  id: "PAY-ORDER-1",
  status: "COMPLETED",
  purchase_units: [{
    reference_id: "reservation-1",
    amount: { currency_code: "USD", value: "25.00" },
    payments: {
      captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" } }],
    },
  }],
};

describe("PayPal capture evidence validation", () => {
  it("accepts a completed capture for the matching order, reservation, and exact cents", () => {
    expect(verifyCompletedCapture(completedOrder, {
      orderId: "PAY-ORDER-1",
      reservationId: "reservation-1",
      amountCents: 2500,
    })).toEqual({
      valid: true,
      evidence: { orderId: "PAY-ORDER-1", captureId: "CAPTURE-1", amountCents: 2500, currency: "USD" },
    });
  });

  it("rejects a different reservation reference", () => {
    expect(verifyCompletedCapture(completedOrder, {
      orderId: "PAY-ORDER-1",
      reservationId: "reservation-2",
      amountCents: 2500,
    })).toEqual({ valid: false, reason: "UNIT_MISMATCH" });
  });

  it("rejects a one-cent amount mismatch without float conversion", () => {
    expect(verifyCompletedCapture(completedOrder, {
      orderId: "PAY-ORDER-1",
      reservationId: "reservation-1",
      amountCents: 2501,
    })).toEqual({ valid: false, reason: "AMOUNT_MISMATCH" });
  });

  it("rejects a provider order that has not completed", () => {
    expect(verifyCompletedCapture({ ...completedOrder, status: "APPROVED" }, {
      orderId: "PAY-ORDER-1",
      reservationId: "reservation-1",
      amountCents: 2500,
    })).toEqual({ valid: false, reason: "ORDER_NOT_COMPLETED" });
  });

  it("validates the remote order reference and amount before capture", () => {
    expect(verifyPayPalOrderAmount(completedOrder, {
      orderId: "PAY-ORDER-1",
      reservationId: "reservation-1",
      amountCents: 2500,
    })).toEqual({ valid: true });
    expect(verifyPayPalOrderAmount(completedOrder, {
      orderId: "PAY-ORDER-1",
      reservationId: "reservation-1",
      amountCents: 2501,
    })).toEqual({ valid: false, reason: "AMOUNT_MISMATCH" });
  });
});

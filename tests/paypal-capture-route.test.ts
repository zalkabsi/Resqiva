import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  PayPalApiError: class FakePayPalApiError extends Error {
    status = 422;
    code = "CAPTURE_REJECTED";
  },
  readSessionFromRequest: vi.fn(),
  isSameOriginMutation: vi.fn(),
  findOrder: vi.fn(),
  updateOrder: vi.fn(),
  findLots: vi.fn(),
  getPayPalOrder: vi.fn(),
  capturePayPalOrder: vi.fn(),
  claimReservationForCapture: vi.fn(),
  finalizeCapturedPayment: vi.fn(),
  flagPaymentException: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  readSessionFromRequest: mocks.readSessionFromRequest,
  isSameOriginMutation: mocks.isSameOriginMutation,
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({ order: { findUnique: mocks.findOrder, updateMany: mocks.updateOrder }, inventoryLot: { findMany: mocks.findLots } }),
}));
vi.mock("@/lib/paypal", () => ({
  getPayPalOrder: mocks.getPayPalOrder,
  capturePayPalOrder: mocks.capturePayPalOrder,
  centsToPayPalAmount: (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
  PayPalApiError: mocks.PayPalApiError,
}));
vi.mock("@/lib/reservations", () => ({ claimReservationForCapture: mocks.claimReservationForCapture }));
vi.mock("@/app/api/paypal/_lib/finalize", () => ({
  finalizeCapturedPayment: mocks.finalizeCapturedPayment,
  flagPaymentException: mocks.flagPaymentException,
  pickupReference: (id: string) => `RSQ-${id.slice(-8).toUpperCase()}`,
}));

import { POST } from "@/app/api/paypal/orders/[paypalOrderId]/capture/route";

describe("POST /api/paypal/orders/[paypalOrderId]/capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readSessionFromRequest.mockReturnValue({ userId: "shopper-1", role: "CUSTOMER" });
    mocks.isSameOriginMutation.mockReturnValue(true);
    mocks.findOrder.mockResolvedValue({
      id: "order-1",
      reservationId: "reservation-1",
      paypalOrderId: "PAYPAL-ORDER-1",
      status: "PENDING",
      paymentStatus: "CREATED",
      amountCents: 500,
      captureRequestId: null,
      userId: "shopper-1",
      reservation: {
        id: "reservation-1",
        status: "RESERVED",
        expiresAt: new Date(Date.now() + 5 * 60_000),
        failureCode: null,
        items: [{ inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500 }],
        bundle: { totalCents: 500 },
      },
      items: [{ inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500 }],
    });
    mocks.findLots.mockResolvedValue([{ id: "lot-1", quantityReserved: 1 }]);
    mocks.getPayPalOrder.mockResolvedValue({
      id: "PAYPAL-ORDER-1",
      status: "APPROVED",
      purchase_units: [{ reference_id: "reservation-1", amount: { currency_code: "USD", value: "5.00" } }],
    });
    mocks.claimReservationForCapture.mockResolvedValue("not_releasable");
    mocks.updateOrder.mockResolvedValue({ count: 1 });
  });

  it("does not send capture when cancellation won the reservation transition", async () => {
    const request = new Request("http://localhost/api/paypal/orders/PAYPAL-ORDER-1/capture", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId: "reservation-1" }),
    });

    const response = await POST(request, { params: Promise.resolve({ paypalOrderId: "PAYPAL-ORDER-1" }) });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("No capture was requested");
    expect(mocks.claimReservationForCapture).toHaveBeenCalledWith("order-1", "reservation-1");
    expect(mocks.capturePayPalOrder).not.toHaveBeenCalled();
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
  });

  it("marks a rejected capture attempt as eligible for later VOIDED-order release", async () => {
    mocks.claimReservationForCapture.mockResolvedValue("claimed");
    mocks.capturePayPalOrder.mockRejectedValue(new mocks.PayPalApiError());
    mocks.getPayPalOrder
      .mockResolvedValueOnce({
        id: "PAYPAL-ORDER-1",
        status: "APPROVED",
        purchase_units: [{ reference_id: "reservation-1", amount: { currency_code: "USD", value: "5.00" } }],
      })
      .mockResolvedValueOnce({ id: "PAYPAL-ORDER-1", status: "VOIDED" });

    const request = new Request("http://localhost/api/paypal/orders/PAYPAL-ORDER-1/capture", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ reservationId: "reservation-1" }),
    });

    const response = await POST(request, { params: Promise.resolve({ paypalOrderId: "PAYPAL-ORDER-1" }) });

    expect(response.status).toBe(502);
    expect(mocks.updateOrder).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "order-1",
        status: "PAYMENT_APPROVED",
        paymentStatus: "APPROVED",
        paymentErrorCode: "CAPTURE_IN_PROGRESS",
      },
      data: expect.objectContaining({ paymentErrorCode: "CAPTURE_REJECTED" }),
    }));
    expect(mocks.capturePayPalOrder).toHaveBeenCalledTimes(1);
  });
});

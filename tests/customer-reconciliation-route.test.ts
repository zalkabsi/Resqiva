import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PayPalOrder } from "@/lib/paypal";

const mocks = vi.hoisted(() => ({
  readSessionFromRequest: vi.fn(),
  isSameOriginMutation: vi.fn(),
  findOrder: vi.fn(),
  findReservation: vi.fn(),
  getPayPalOrder: vi.fn(),
  releaseReservation: vi.fn(),
  finalizeCapturedPayment: vi.fn(),
  flagPaymentException: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  readSessionFromRequest: mocks.readSessionFromRequest,
  isSameOriginMutation: mocks.isSameOriginMutation,
}));
vi.mock("@/lib/db", () => ({
  getDb: () => ({ order: { findFirst: mocks.findOrder }, reservation: { findUnique: mocks.findReservation } }),
}));
vi.mock("@/lib/paypal", async () => ({
  ...(await vi.importActual<typeof import("@/lib/paypal")>("@/lib/paypal")),
  getPayPalOrder: mocks.getPayPalOrder,
}));
vi.mock("@/lib/reservations", () => ({
  ReservationError: class ReservationError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  },
  releaseReservation: mocks.releaseReservation,
}));
vi.mock("@/app/api/paypal/_lib/finalize", () => ({
  finalizeCapturedPayment: mocks.finalizeCapturedPayment,
  flagPaymentException: mocks.flagPaymentException,
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

import { POST } from "@/app/api/reservations/[reservationId]/reconcile/route";

function savedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-12345678",
    reservationId: "reservation-12345678",
    status: "PAYMENT_EXCEPTION",
    paymentStatus: "UNKNOWN",
    amountCents: 2500,
    currency: "USD",
    paypalOrderId: "PAYPAL-ORDER-1",
    reservation: {
      id: "reservation-12345678",
      status: "PAYMENT_EXCEPTION",
      failureCode: "CAPTURE_UNCERTAIN",
      expiresAt: new Date(Date.now() + 60_000),
    },
    ...overrides,
  };
}

function completedPayPalOrder(overrides: Record<string, unknown> = {}): PayPalOrder {
  return {
    id: "PAYPAL-ORDER-1",
    status: "COMPLETED",
    purchase_units: [{
      reference_id: "reservation-12345678",
      amount: { currency_code: "USD", value: "25.00" },
      payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" } }] },
    }],
    ...overrides,
  };
}

function request(body?: string, origin: string | null = "https://resqiva.test") {
  return new Request("https://resqiva.test/api/reservations/reservation-12345678/reconcile", {
    method: "POST",
    headers: { ...(origin ? { Origin: origin } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body } : {}),
  });
}

function context(reservationId = "reservation-12345678") {
  return { params: Promise.resolve({ reservationId }) };
}

describe("POST /api/reservations/[reservationId]/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSameOriginMutation.mockReturnValue(true);
    mocks.readSessionFromRequest.mockReturnValue({ userId: "customer-1", role: "CUSTOMER" });
    mocks.findOrder.mockResolvedValue(savedOrder());
    mocks.findReservation.mockResolvedValue({ status: "CANCELLED" });
    mocks.checkRateLimit.mockReturnValue({ allowed: true, remaining: 9, retryAfterSeconds: 60 });
    mocks.flagPaymentException.mockResolvedValue(undefined);
  });

  it("requires an explicit same-origin request", async () => {
    const response = await POST(request(undefined, null), context());

    expect(response.status).toBe(403);
    expect(mocks.readSessionFromRequest).not.toHaveBeenCalled();
    expect(mocks.findOrder).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin mutation", async () => {
    mocks.isSameOriginMutation.mockReturnValue(false);

    const response = await POST(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.readSessionFromRequest).not.toHaveBeenCalled();
    expect(mocks.findOrder).not.toHaveBeenCalled();
  });

  it.each([
    [null, 401],
    [{ userId: "merchant-1", role: "MERCHANT_ADMIN" }, 401],
  ])("requires a signed customer session", async (session, expectedStatus) => {
    mocks.readSessionFromRequest.mockReturnValue(session);

    const response = await POST(request(), context());

    expect(response.status).toBe(expectedStatus);
    expect(mocks.findOrder).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("rejects request bodies so IDs and amounts come only from saved data", async () => {
    const response = await POST(request(JSON.stringify({ paypalOrderId: "ATTACKER", amountCents: 1 })), context());

    expect(response.status).toBe(400);
    expect(mocks.findOrder).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("rate-limits provider lookups per signed customer", async () => {
    mocks.checkRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 31 });

    const response = await POST(request(), context());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("31");
    expect(mocks.findOrder).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("looks up only an order and reservation owned by the signed-in customer", async () => {
    mocks.findOrder.mockResolvedValue(null);

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    expect(mocks.findOrder).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        reservationId: "reservation-12345678",
        userId: "customer-1",
        reservation: { userId: "customer-1" },
      },
    }));
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("returns a completed local order idempotently", async () => {
    mocks.findOrder.mockResolvedValue(savedOrder({ status: "PAID", paymentStatus: "CAPTURED" }));

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "PAID", paymentStatus: "CAPTURED", idempotent: true });
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
  });

  it("does not query PayPal without a saved provider order ID", async () => {
    mocks.findOrder.mockResolvedValue(savedOrder({ paypalOrderId: null }));

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("does not change state if the mocked provider lookup fails", async () => {
    mocks.getPayPalOrder.mockRejectedValue(new Error("mock provider failure"));

    const response = await POST(request(), context());

    expect(response.status).toBe(502);
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).not.toHaveBeenCalled();
  });

  it.each(["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED", "UNKNOWN_STATUS"])(
    "does not release or finalize a mocked provider order in %s state",
    async (providerStatus) => {
      mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: providerStatus });

      const response = await POST(request(), context());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.released).toBe(false);
      expect(body.finalized).toBe(false);
      expect(mocks.releaseReservation).not.toHaveBeenCalled();
      expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
      expect(mocks.flagPaymentException).not.toHaveBeenCalled();
    },
  );

  it("calls the release helper only for a mocked VOIDED order and reports confirmed release", async () => {
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });
    mocks.releaseReservation.mockResolvedValue("released");

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "CANCELLED", released: true });
    expect(mocks.releaseReservation).toHaveBeenCalledWith("reservation-12345678", "CANCELLED", "customer-1");
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
  });

  it("reports a VOIDED order as unreleasable when the helper cannot confirm release", async () => {
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });
    mocks.releaseReservation.mockResolvedValue("not_releasable");

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("inventory remains held") });
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
  });

  it.each(["CANCELLED", "EXPIRED"])("reports previously released %s stock on a repeated VOIDED reconciliation", async (status) => {
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });
    mocks.releaseReservation.mockResolvedValue("already_final");
    mocks.findReservation.mockResolvedValue({ status });

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status, released: true, idempotent: true });
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
  });

  it("finalizes a mocked completed capture only when exact saved evidence matches", async () => {
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());
    mocks.finalizeCapturedPayment.mockResolvedValue({
      status: "PAID",
      orderId: "order-12345678",
      pickupReference: "RSQ-12345678",
      idempotent: false,
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "PAID", paymentStatus: "CAPTURED", idempotent: false });
    expect(mocks.finalizeCapturedPayment).toHaveBeenCalledWith({
      orderId: "PAYPAL-ORDER-1",
      captureId: "CAPTURE-1",
      amountCents: 2500,
      currency: "USD",
    });
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it.each([
    ["provider order ID", { id: "OTHER-ORDER" }],
    ["reservation reference", { purchase_units: [{ reference_id: "another-reservation" }] }],
    ["captured amount", { purchase_units: [{ reference_id: "reservation-12345678", amount: { currency_code: "USD", value: "24.99" }, payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: { currency_code: "USD", value: "24.99" } }] } }] }],
    ["capture status", { purchase_units: [{ reference_id: "reservation-12345678", amount: { currency_code: "USD", value: "25.00" }, payments: { captures: [{ id: "CAPTURE-1", status: "PENDING", amount: { currency_code: "USD", value: "25.00" } }] } }] }],
  ])("flags an exception and never finalizes when mocked %s evidence mismatches", async (_label, change) => {
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder(change));

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", expect.stringMatching(/^RECONCILIATION_/));
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("rejects a completed capture if the saved order currency is unsupported", async () => {
    mocks.findOrder.mockResolvedValue(savedOrder({ currency: "EUR" }));
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", "RECONCILIATION_AMOUNT_MISMATCH");
  });

  it.each(["CANCELLED", "EXPIRED"])("records a mocked late capture for a %s reservation without finalizing or releasing stock", async (status) => {
    mocks.findOrder.mockResolvedValue(savedOrder({
      status,
      paymentStatus: "UNKNOWN",
      reservation: { id: "reservation-12345678", status, failureCode: null, expiresAt: new Date(Date.now() - 60_000) },
    }));
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "PAYMENT_EXCEPTION" });
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", "LATE_CAPTURE_AFTER_RESERVATION_CLOSED");
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
  });

  it("records an expired RESERVED late capture without consuming stock", async () => {
    mocks.findOrder.mockResolvedValue(savedOrder({
      status: "PENDING",
      paymentStatus: "CREATED",
      reservation: { id: "reservation-12345678", status: "RESERVED", failureCode: null, expiresAt: new Date(Date.now() - 60_000) },
    }));
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.releaseReservation).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", "LATE_CAPTURE_AFTER_RESERVATION_CLOSED");
  });

  it("does not automatically finalize a non-recoverable payment exception", async () => {
    mocks.findOrder.mockResolvedValue(savedOrder({
      reservation: { id: "reservation-12345678", status: "PAYMENT_EXCEPTION", failureCode: "PAYMENT_REVERSED", expiresAt: new Date(Date.now() + 60_000) },
    }));
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", "RECONCILIATION_STATE_MISMATCH");
  });

  it("returns idempotent paid status when the same verified order is reconciled twice", async () => {
    mocks.findOrder
      .mockResolvedValueOnce(savedOrder())
      .mockResolvedValueOnce(savedOrder({ status: "PAID", paymentStatus: "CAPTURED" }));
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());
    mocks.finalizeCapturedPayment.mockResolvedValue({
      status: "PAID",
      orderId: "order-12345678",
      pickupReference: "RSQ-12345678",
      idempotent: false,
    });

    const first = await POST(request(), context());
    const second = await POST(request(), context());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "PAID", paymentStatus: "CAPTURED", idempotent: true });
    expect(mocks.getPayPalOrder).toHaveBeenCalledOnce();
    expect(mocks.finalizeCapturedPayment).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PayPalOrder } from "@/lib/paypal";

const mocks = vi.hoisted(() => ({
  authorizeDemoMerchant: vi.fn(),
  sameOriginRequired: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  getPayPalOrder: vi.fn(),
  finalizeCapturedPayment: vi.fn(),
  flagPaymentException: vi.fn(),
  releaseReservation: vi.fn(),
  reservationFindUnique: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/merchant-auth", () => ({
  authorizeDemoMerchant: mocks.authorizeDemoMerchant,
  sameOriginRequired: mocks.sameOriginRequired,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({
  order: { findFirst: mocks.findFirst, updateMany: mocks.updateMany },
  reservation: { findUnique: mocks.reservationFindUnique },
}) }));
vi.mock("@/lib/paypal", async () => ({
  ...(await vi.importActual<typeof import("@/lib/paypal")>("@/lib/paypal")),
  getPayPalOrder: mocks.getPayPalOrder,
}));
vi.mock("@/app/api/paypal/_lib/finalize", () => ({
  finalizeCapturedPayment: mocks.finalizeCapturedPayment,
  flagPaymentException: mocks.flagPaymentException,
}));
vi.mock("@/lib/reservations", () => ({ releaseReservation: mocks.releaseReservation }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

import { POST } from "@/app/api/merchant/orders/[orderId]/reconcile/route";

const adminAuthorization = {
  ok: true as const,
  context: { userId: "merchant-user", merchantId: "merchant-1", role: "MERCHANT_ADMIN" as const },
};

function savedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-12345678",
    reservationId: "reservation-1",
    status: "PAYMENT_EXCEPTION",
    paymentStatus: "UNKNOWN",
    amountCents: 2500,
    currency: "USD",
    paypalOrderId: "PAYPAL-ORDER-1",
    reservation: {
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
      reference_id: "reservation-1",
      amount: { currency_code: "USD", value: "25.00" },
      payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: { currency_code: "USD", value: "25.00" } }] },
    }],
    ...overrides,
  };
}

function request(body?: string, origin: string | null = "https://resqiva.test") {
  return new Request("https://resqiva.test/api/merchant/orders/order-12345678/reconcile", {
    method: "POST",
    headers: { ...(origin ? { Origin: origin } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body } : {}),
  });
}

function context(orderId = "order-12345678") {
  return { params: Promise.resolve({ orderId }) };
}

describe("POST /api/merchant/orders/[orderId]/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sameOriginRequired.mockReturnValue(null);
    mocks.authorizeDemoMerchant.mockResolvedValue(adminAuthorization);
    mocks.findFirst.mockResolvedValue(savedOrder());
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.flagPaymentException.mockResolvedValue(undefined);
    mocks.releaseReservation.mockResolvedValue("not_releasable");
    mocks.reservationFindUnique.mockResolvedValue(null);
    mocks.checkRateLimit.mockReturnValue({ allowed: true, remaining: 9, retryAfterSeconds: 60 });
  });

  it("requires an Origin header even in local development", async () => {
    const response = await POST(request(undefined, null), context());

    expect(response.status).toBe(403);
    expect(mocks.authorizeDemoMerchant).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests before merchant authorization", async () => {
    const denied = new Response("blocked", { status: 403 });
    mocks.sameOriginRequired.mockReturnValue(denied);

    const response = await POST(request(), context());

    expect(response).toBe(denied);
    expect(mocks.authorizeDemoMerchant).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("enforces merchant authorization", async () => {
    const denied = new Response("unauthorized", { status: 401 });
    mocks.authorizeDemoMerchant.mockResolvedValue({ ok: false, response: denied });

    const response = await POST(request(), context());

    expect(response).toBe(denied);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("limits reconciliation to merchant administrators", async () => {
    mocks.authorizeDemoMerchant.mockResolvedValue({
      ok: true,
      context: { userId: "staff-user", merchantId: "merchant-1", role: "MERCHANT_STAFF" },
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("rejects request bodies so provider IDs and totals can only come from saved data", async () => {
    const response = await POST(request(JSON.stringify({ paypalOrderId: "ATTACKER-ID", amountCents: 1 })), context());

    expect(response.status).toBe(400);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
  });

  it("rate-limits repeated provider status checks per merchant admin", async () => {
    mocks.checkRateLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 37 });

    const response = await POST(request(), context());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("scopes saved order lookup to the authorized demo merchant", async () => {
    mocks.findFirst.mockResolvedValue(null);

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    expect(mocks.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "order-12345678", store: { merchantId: "merchant-1", isDemo: true } },
    }));
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("returns already-finalized orders idempotently without querying PayPal", async () => {
    mocks.findFirst.mockResolvedValue(savedOrder({ status: "PAID", paymentStatus: "CAPTURED" }));

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "PAID", paymentStatus: "CAPTURED", idempotent: true });
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
  });

  it("does not query PayPal if there is no saved provider order reference", async () => {
    mocks.findFirst.mockResolvedValue(savedOrder({ paypalOrderId: null }));

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
  });

  it("records the check and preserves state when PayPal cannot be reached", async () => {
    mocks.getPayPalOrder.mockRejectedValue(new Error("provider unavailable"));

    const response = await POST(request(), context());

    expect(response.status).toBe(502);
    expect(mocks.updateMany).toHaveBeenCalledOnce();
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).not.toHaveBeenCalled();
  });

  it.each(["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED", "UNRECOGNIZED"])(
    "does not finalize provider status %s",
    async (providerStatus) => {
      mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: providerStatus });

      const response = await POST(request(), context());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.finalized).toBe(false);
      expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
      expect(mocks.flagPaymentException).not.toHaveBeenCalled();
    },
  );

  it("releases a saved reservation only through the shared safe helper after a VOIDED status", async () => {
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });
    mocks.releaseReservation.mockResolvedValue("released");

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "CANCELLED",
      paymentStatus: "FAILED",
      finalized: false,
      released: true,
      idempotent: false,
    });
    expect(mocks.releaseReservation).toHaveBeenCalledWith("reservation-1", "CANCELLED", "merchant-user", "MERCHANT");
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).not.toHaveBeenCalled();
  });

  it("keeps inventory held when a VOIDED status cannot pass the shared local-state checks", async () => {
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });
    mocks.releaseReservation.mockResolvedValue("not_releasable");

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "VOIDED",
      paymentStatus: "UNKNOWN",
      finalized: false,
      released: false,
      held: true,
    });
    expect(mocks.releaseReservation).toHaveBeenCalledOnce();
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).not.toHaveBeenCalled();
  });

  it("confirms a previously released terminal reservation idempotently", async () => {
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });
    mocks.releaseReservation.mockResolvedValue("already_final");
    mocks.reservationFindUnique.mockResolvedValue({ status: "EXPIRED", releasedAt: new Date() });

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "EXPIRED",
      paymentStatus: "FAILED",
      finalized: false,
      released: true,
      idempotent: true,
    });
    expect(mocks.reservationFindUnique).toHaveBeenCalledWith({
      where: { id: "reservation-1" },
      select: { status: true, releasedAt: true },
    });
  });

  it("finalizes exact provider-verified capture evidence for a saved recoverable exception", async () => {
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
    expect(mocks.flagPaymentException).not.toHaveBeenCalled();
  });

  it.each([
    ["provider order ID", { id: "OTHER-ORDER" }],
    ["reservation reference", { purchase_units: [{ reference_id: "another-reservation" }] }],
    ["captured amount", { purchase_units: [{ reference_id: "reservation-1", amount: { currency_code: "USD", value: "24.99" }, payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED", amount: { currency_code: "USD", value: "24.99" } }] } }] }],
    ["capture status", { purchase_units: [{ reference_id: "reservation-1", amount: { currency_code: "USD", value: "25.00" }, payments: { captures: [{ id: "CAPTURE-1", status: "PENDING", amount: { currency_code: "USD", value: "25.00" } }] } }] }],
  ])("holds the exception without finalizing when %s does not match", async (_label, change) => {
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder(change));

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", expect.stringMatching(/^RECONCILIATION_/));
  });

  it("does not finalize capture evidence when the saved order uses another currency", async () => {
    mocks.findFirst.mockResolvedValue(savedOrder({ currency: "EUR" }));
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", "RECONCILIATION_AMOUNT_MISMATCH");
  });

  it.each(["CANCELLED", "EXPIRED"])("records a late capture for a %s reservation without finalizing or consuming stock", async (status) => {
    mocks.findFirst.mockResolvedValue(savedOrder({
      status,
      paymentStatus: "UNKNOWN",
      reservation: { status, failureCode: null, expiresAt: new Date(Date.now() - 60_000) },
    }));
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: "PAYMENT_EXCEPTION" });
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", "LATE_CAPTURE_AFTER_RESERVATION_CLOSED");
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
  });

  it("does not finalize an expired still-reserved reservation", async () => {
    mocks.findFirst.mockResolvedValue(savedOrder({
      status: "PENDING",
      paymentStatus: "CREATED",
      reservation: { status: "RESERVED", failureCode: null, expiresAt: new Date(Date.now() - 60_000) },
    }));
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", "LATE_CAPTURE_AFTER_RESERVATION_CLOSED");
  });

  it("leaves a non-recoverable payment exception out of automatic finalization", async () => {
    mocks.findFirst.mockResolvedValue(savedOrder({
      reservation: { status: "PAYMENT_EXCEPTION", failureCode: "PAYMENT_REVERSED", expiresAt: new Date(Date.now() + 60_000) },
    }));
    mocks.getPayPalOrder.mockResolvedValue(completedPayPalOrder());

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    expect(mocks.finalizeCapturedPayment).not.toHaveBeenCalled();
    expect(mocks.flagPaymentException).toHaveBeenCalledWith("PAYPAL-ORDER-1", "RECONCILIATION_STATE_MISMATCH");
  });

  it("returns the idempotent paid result after repeated reconciliation calls", async () => {
    mocks.findFirst
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

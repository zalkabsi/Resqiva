import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isSameOriginMutation: vi.fn(),
  readSessionFromRequest: vi.fn(),
  getDb: vi.fn(),
  findOrder: vi.fn(),
  findLots: vi.fn(),
  getPayPalOrder: vi.fn(),
  capturePayPalOrder: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  isSameOriginMutation: mocks.isSameOriginMutation,
  readSessionFromRequest: mocks.readSessionFromRequest,
}));
vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));
vi.mock("@/lib/paypal", () => ({
  getPayPalOrder: mocks.getPayPalOrder,
  capturePayPalOrder: mocks.capturePayPalOrder,
  PayPalApiError: class FakePayPalApiError extends Error {},
}));
vi.mock("@/lib/reservations", () => ({ claimReservationForCapture: vi.fn() }));
vi.mock("@/app/api/paypal/_lib/finalize", () => ({
  finalizeCapturedPayment: vi.fn(),
  flagPaymentException: vi.fn(),
  pickupReference: vi.fn(),
}));

import { POST } from "@/app/api/paypal/orders/[paypalOrderId]/capture/route";

function request(body: string, origin = "http://localhost") {
  return new Request("http://localhost/api/paypal/orders/PAYPAL-ORDER-1/capture", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body,
  });
}

function context() {
  return { params: Promise.resolve({ paypalOrderId: "PAYPAL-ORDER-1" }) };
}

describe("POST /api/paypal/orders/[paypalOrderId]/capture request limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSameOriginMutation.mockReturnValue(true);
    mocks.readSessionFromRequest.mockReturnValue({ userId: "shopper-1", role: "CUSTOMER" });
    mocks.getDb.mockReturnValue({
      order: { findUnique: mocks.findOrder },
      inventoryLot: { findMany: mocks.findLots },
    });
  });

  it("rejects an oversized body before database or provider calls", async () => {
    const response = await POST(request(" ".repeat(4 * 1024 + 1)), context());

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
    expect(mocks.capturePayPalOrder).not.toHaveBeenCalled();
  });

  it("preserves origin and session checks before reading the request body", async () => {
    mocks.isSameOriginMutation.mockReturnValue(false);
    const crossOrigin = await POST(request(" ".repeat(4 * 1024 + 1), "https://attacker.example"), context());
    expect(crossOrigin.status).toBe(403);
    expect(mocks.readSessionFromRequest).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.isSameOriginMutation.mockReturnValue(true);
    mocks.readSessionFromRequest.mockReturnValue(null);
    const unauthenticated = await POST(request(" ".repeat(4 * 1024 + 1)), context());
    expect(unauthenticated.status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
  });

  it("keeps the existing malformed-JSON response for small bodies", async () => {
    const response = await POST(request("{"), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Request body must be valid JSON." });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});

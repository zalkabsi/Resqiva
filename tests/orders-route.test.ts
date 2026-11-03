import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSessionFromRequest: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ readSessionFromRequest: mocks.readSessionFromRequest }));
vi.mock("@/lib/db", () => ({ getDb: () => ({ order: { findMany: mocks.findMany } }) }));

import { GET } from "@/app/api/orders/route";

function request() {
  return new Request("http://localhost/api/orders");
}

describe("GET /api/orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires a customer session and does not query the database when absent", async () => {
    mocks.readSessionFromRequest.mockReturnValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("does not expose customer history to a merchant session", async () => {
    mocks.readSessionFromRequest.mockReturnValue({ userId: "merchant-1", role: "MERCHANT_ADMIN" });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns only the signed-in demo customer's safe order receipt data", async () => {
    const paidAt = new Date("2026-11-03T10:00:00.000Z");
    const startsAt = new Date("2026-11-04T15:00:00.000Z");
    const endsAt = new Date("2026-11-04T16:00:00.000Z");
    mocks.readSessionFromRequest.mockReturnValue({ userId: "customer-7", role: "CUSTOMER" });
    mocks.findMany.mockResolvedValue([{
      id: "order-abc12345",
      status: "PAID",
      paymentStatus: "CAPTURED",
      currency: "USD",
      amountCents: 2500,
      createdAt: paidAt,
      paidAt,
      fulfilledAt: null,
      store: { name: "DEMO — Green Basket Market" },
      pickupWindow: { startsAt, endsAt },
      items: [{ productNameSnapshot: "Tomatoes", quantity: 2, unitPriceCents: 500, originalUnitPriceCents: 800 }],
      paypalOrderId: "must-not-be-selected-or-returned",
      paypalCaptureId: "must-not-be-returned",
    }]);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "customer-7", user: { isDemo: true } },
      take: 50,
    }));
    expect(body).toEqual({ orders: [{
      id: "order-abc12345",
      pickupReference: "ABC12345",
      status: "PAID",
      paymentStatus: "CAPTURED",
      currency: "USD",
      amountCents: 2500,
      createdAt: paidAt.toISOString(),
      paidAt: paidAt.toISOString(),
      fulfilledAt: null,
      storeName: "DEMO — Green Basket Market",
      pickupStart: startsAt.toISOString(),
      pickupEnd: endsAt.toISOString(),
      items: [{ productName: "Tomatoes", quantity: 2, unitPriceCents: 500, originalUnitPriceCents: 800 }],
    }] });
    expect(JSON.stringify(body)).not.toContain("paypalOrderId");
    expect(JSON.stringify(body)).not.toContain("paypalCaptureId");
  });

  it("returns a sanitized service error if the database query fails", async () => {
    mocks.readSessionFromRequest.mockReturnValue({ userId: "customer-7", role: "CUSTOMER" });
    mocks.findMany.mockRejectedValue(new Error("database connection URL must not be exposed"));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "Order history could not be loaded." });
    expect(JSON.stringify(body)).not.toContain("database connection URL");
  });
});

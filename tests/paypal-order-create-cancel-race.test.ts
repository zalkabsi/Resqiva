import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PayPalOrder } from "@/lib/paypal";

const mocks = vi.hoisted(() => ({
  readSessionFromRequest: vi.fn(),
  isSameOriginMutation: vi.fn(),
  reservationFindUnique: vi.fn(),
  orderCreate: vi.fn(),
  orderFindUnique: vi.fn(),
  orderUpdate: vi.fn(),
  transaction: vi.fn(),
  transactionReservationFindUnique: vi.fn(),
  transactionReservationUpdateMany: vi.fn(),
  transactionOrderFindUnique: vi.fn(),
  transactionOrderUpdateMany: vi.fn(),
  paypalTransactionUpsert: vi.fn(),
  auditEventCreate: vi.fn(),
  createPayPalOrder: vi.fn(),
  getPayPalOrder: vi.fn(),
  paypalApprovalUrl: vi.fn(),
  reservationState: null as Record<string, unknown> | null,
  orderState: null as Record<string, unknown> | null,
  db: null as Record<string, unknown> | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({
  readSessionFromRequest: mocks.readSessionFromRequest,
  isSameOriginMutation: mocks.isSameOriginMutation,
}));
vi.mock("@/lib/db", () => ({ getDb: () => mocks.db }));
vi.mock("@/lib/paypal", async () => ({
  ...(await vi.importActual<typeof import("@/lib/paypal")>("@/lib/paypal")),
  createPayPalOrder: mocks.createPayPalOrder,
  getPayPalOrder: mocks.getPayPalOrder,
  paypalApprovalUrl: mocks.paypalApprovalUrl,
}));
vi.mock("@/app/api/paypal/_lib/finalize", () => ({
  finalizeCapturedPayment: vi.fn(),
  flagPaymentException: vi.fn(),
}));

import { POST } from "@/app/api/paypal/orders/route";

const providerOrder: PayPalOrder = {
  id: "PAYPAL-ORDER-1",
  status: "CREATED",
  purchase_units: [{
    reference_id: "reservation-1",
    amount: { currency_code: "USD", value: "5.00" },
  }],
  links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-1", rel: "approve" }],
};

function reservation() {
  return {
    id: "reservation-1",
    userId: "shopper-1",
    status: "RESERVED",
    expiresAt: new Date(Date.now() + 5 * 60_000),
    storeId: "store-1",
    pickupWindowId: "window-1",
    items: [{
      inventoryLotId: "lot-1",
      quantity: 1,
      unitPriceCents: 500,
      originalUnitPriceCents: 700,
      inventoryLot: { product: { name: "Tomatoes", sku: "TOM-1" } },
    }],
    bundle: { id: "bundle-1", totalCents: 500 },
    store: { id: "store-1", isDemo: true, currency: "USD" },
    order: null,
  };
}

function request() {
  return new Request("http://localhost/api/paypal/orders", {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ reservationId: "reservation-1" }),
  });
}

function makeTransactionMock() {
  mocks.transaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) => operation({
    reservation: {
      findUnique: mocks.transactionReservationFindUnique,
      updateMany: mocks.transactionReservationUpdateMany,
    },
    order: {
      findUnique: mocks.transactionOrderFindUnique,
      updateMany: mocks.transactionOrderUpdateMany,
    },
    paypalTransaction: { upsert: mocks.paypalTransactionUpsert },
    auditEvent: { create: mocks.auditEventCreate },
  }));
}

describe("POST /api/paypal/orders order-create/cancel race", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reservationState = reservation();
    mocks.orderState = null;
    mocks.readSessionFromRequest.mockReturnValue({ userId: "shopper-1", role: "CUSTOMER" });
    mocks.isSameOriginMutation.mockReturnValue(true);
    mocks.reservationFindUnique.mockImplementation(async () => mocks.reservationState);
    mocks.orderCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      mocks.orderState = {
        id: "order-1",
        status: "PENDING",
        paymentStatus: "CREATED",
        paypalOrderId: null,
        amountCents: 500,
        createRequestId: args.data.createRequestId,
      };
      return mocks.orderState;
    });
    mocks.orderFindUnique.mockImplementation(async () => mocks.orderState);
    mocks.orderUpdate.mockResolvedValue({});
    mocks.transactionReservationFindUnique.mockImplementation(async () => mocks.reservationState);
    mocks.transactionReservationUpdateMany.mockImplementation(async ({ where }: { where: { status: string; expiresAt: { gt: Date } } }) => {
      const state = mocks.reservationState as Record<string, unknown>;
      const expiration = state.expiresAt as Date;
      return { count: state.status === where.status && expiration > where.expiresAt.gt ? 1 : 0 };
    });
    mocks.transactionOrderFindUnique.mockImplementation(async () => mocks.orderState);
    mocks.transactionOrderUpdateMany.mockImplementation(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const state = mocks.orderState as Record<string, unknown>;
      if (where.id !== state.id || where.paypalOrderId !== state.paypalOrderId) return { count: 0 };
      if (where.status !== undefined && where.status !== state.status) return { count: 0 };
      if (where.paymentStatus !== undefined && where.paymentStatus !== state.paymentStatus) return { count: 0 };
      Object.assign(state, data);
      return { count: 1 };
    });
    mocks.paypalTransactionUpsert.mockResolvedValue({});
    mocks.auditEventCreate.mockResolvedValue({});
    mocks.transaction.mockReset();
    makeTransactionMock();
    mocks.db = {
      reservation: { findUnique: mocks.reservationFindUnique },
      order: { create: mocks.orderCreate, findUnique: mocks.orderFindUnique, update: mocks.orderUpdate },
      $transaction: mocks.transaction,
    };
    mocks.createPayPalOrder.mockResolvedValue(providerOrder);
    mocks.getPayPalOrder.mockResolvedValue(providerOrder);
    mocks.paypalApprovalUrl.mockReturnValue("https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-1");
  });

  it("does not resurrect or return an approval link after cancellation wins during PayPal order creation", async () => {
    mocks.createPayPalOrder.mockImplementation(async () => {
      // Deterministically model releaseReservation committing before the local
      // callback persists the order returned by PayPal.
      mocks.reservationState = {
        ...(mocks.reservationState as Record<string, unknown>),
        status: "CANCELLED",
      };
      mocks.orderState = {
        ...(mocks.orderState as Record<string, unknown>),
        status: "CANCELLED",
        paymentStatus: "FAILED",
      };
      return providerOrder;
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("No approval link was issued");
    expect(body.approvalUrl).toBeUndefined();
    expect(mocks.paypalApprovalUrl).not.toHaveBeenCalled();
    expect(mocks.reservationState).toMatchObject({ status: "CANCELLED" });
    expect(mocks.orderState).toMatchObject({
      status: "CANCELLED",
      paymentStatus: "FAILED",
      paypalOrderId: "PAYPAL-ORDER-1",
    });
    expect(mocks.transactionOrderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", paypalOrderId: null },
      data: { paypalOrderId: "PAYPAL-ORDER-1" },
    });
    expect(mocks.paypalTransactionUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { providerTransactionId: "PAYPAL-ORDER-1" },
      create: expect.objectContaining({ orderId: "order-1", requestId: "resqiva-create-reservation-1" }),
    }));
    expect(mocks.transactionOrderUpdateMany.mock.calls.flatMap(([call]) => Object.keys(call.data))).not.toContain("status");
    expect(mocks.createPayPalOrder).toHaveBeenCalledOnce();
  });

  it("returns approval only after the active reservation and pending order are claimed", async () => {
    mocks.transactionReservationUpdateMany.mockImplementation(async () => ({ count: 1 }));

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      paypalOrderId: "PAYPAL-ORDER-1",
      approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-1",
      status: "PENDING",
    });
    expect(mocks.orderState).toMatchObject({ status: "PENDING", paymentStatus: "CREATED", paypalOrderId: "PAYPAL-ORDER-1" });
    expect(mocks.transactionOrderUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "order-1", paypalOrderId: null, status: "PENDING", paymentStatus: "CREATED" },
      data: { paypalOrderId: "PAYPAL-ORDER-1" },
    }));
    expect(mocks.paypalApprovalUrl).toHaveBeenCalledOnce();
  });

  it("does not return a stale approval link when cancellation wins during GET for an already-linked order", async () => {
    const existingOrder = {
      id: "order-1",
      status: "PENDING",
      paymentStatus: "CREATED",
      paypalOrderId: "PAYPAL-ORDER-1",
      amountCents: 500,
      createRequestId: "resqiva-create-reservation-1",
    };
    mocks.orderState = existingOrder;
    mocks.reservationState = { ...(reservation()), order: existingOrder };
    mocks.getPayPalOrder.mockImplementation(async () => {
      // Model a successful customer cancellation while the GET request is in
      // flight. The retry branch must use fresh database state before returning.
      const cancelledOrder = { ...existingOrder, status: "CANCELLED", paymentStatus: "FAILED" };
      mocks.orderState = cancelledOrder;
      mocks.reservationState = {
        ...(mocks.reservationState as Record<string, unknown>),
        status: "CANCELLED",
        order: cancelledOrder,
      };
      return providerOrder;
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("No approval link was issued");
    expect(body.approvalUrl).toBeUndefined();
    expect(mocks.getPayPalOrder).toHaveBeenCalledWith("PAYPAL-ORDER-1");
    expect(mocks.reservationState).toMatchObject({ status: "CANCELLED" });
    expect(mocks.orderState).toMatchObject({
      status: "CANCELLED",
      paymentStatus: "FAILED",
      paypalOrderId: "PAYPAL-ORDER-1",
    });
    expect(mocks.transactionReservationUpdateMany).not.toHaveBeenCalled();
    expect(mocks.transactionOrderUpdateMany).not.toHaveBeenCalled();
  });
});

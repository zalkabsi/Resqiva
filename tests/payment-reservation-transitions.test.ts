import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PayPalOrder } from "@/lib/paypal";

type RecordValue = Record<string, unknown>;
type Fixture = {
  reservation: RecordValue;
  order: RecordValue;
  lot: RecordValue;
  pickupWindow: RecordValue;
  bundle: RecordValue;
};

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  getPayPalOrder: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/lib/paypal", () => ({ getPayPalOrder: mocks.getPayPalOrder }));

import { finalizeCapturedPayment } from "@/app/api/paypal/_lib/finalize";
import { claimReservationForCapture, releaseReservation } from "@/lib/reservations";

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  const reservation: RecordValue = {
    id: "reservation-1",
    status: "RESERVED",
    expiresAt: new Date(Date.now() + 10 * 60_000),
    userId: "shopper-1",
    storeId: "store-1",
    bundleId: "bundle-1",
    pickupWindowId: "window-1",
    paymentApprovedAt: null,
    failureCode: null,
    failureSummary: null,
    items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
  };
  const order: RecordValue = {
    id: "order-1",
    reservationId: "reservation-1",
    paypalOrderId: "PAYPAL-ORDER-1",
    status: "PENDING",
    paymentStatus: "CREATED",
    amountCents: 500,
    currency: "USD",
    paymentErrorCode: null,
    paymentErrorSummary: null,
    updatedAt: new Date(),
    storeId: "store-1",
    captureRequestId: null,
    items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
  };
  return {
    reservation: structuredClone(reservation),
    order: structuredClone(order),
    lot: { id: "lot-1", quantityOnHand: 1, quantityReserved: 1, quantitySold: 0 },
    pickupWindow: { id: "window-1", reservedUnits: 1 },
    bundle: { id: "bundle-1", status: "RESERVED" },
    ...overrides,
  };
}

function matches(record: RecordValue, where: RecordValue): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected) && !(expected instanceof Date)) {
      const operators = expected as RecordValue;
      if ("in" in operators) return Array.isArray(operators.in) && operators.in.includes(actual);
      if ("notIn" in operators) return Array.isArray(operators.notIn) && !operators.notIn.includes(actual);
      if ("gt" in operators) return actual instanceof Date && operators.gt instanceof Date && actual > operators.gt;
      if ("gte" in operators) return typeof actual === "number" && typeof operators.gte === "number" && actual >= operators.gte;
      if ("lte" in operators) return actual instanceof Date && operators.lte instanceof Date && actual <= operators.lte;
      return actual !== null && typeof actual === "object" && !Array.isArray(actual)
        && matches(actual as RecordValue, operators);
    }
    return actual instanceof Date && expected instanceof Date ? actual.getTime() === expected.getTime() : actual === expected;
  });
}

function apply(record: RecordValue, data: RecordValue) {
  for (const [key, next] of Object.entries(data)) {
    if (next && typeof next === "object" && !Array.isArray(next) && !(next instanceof Date)) {
      const operation = next as RecordValue;
      if (typeof operation.increment === "number") {
        record[key] = Number(record[key]) + operation.increment;
        continue;
      }
      if (typeof operation.decrement === "number") {
        record[key] = Number(record[key]) - operation.decrement;
        continue;
      }
    }
    if (next !== undefined) record[key] = next;
  }
}

function mockDb(state: Fixture) {
  const reservationRecord = () => ({
    ...structuredClone(state.reservation),
    items: structuredClone(state.reservation.items),
    order: structuredClone(state.order),
    pickupWindow: structuredClone(state.pickupWindow),
  });
  const orderRecord = () => ({
    ...structuredClone(state.order),
    reservation: {
      ...structuredClone(state.reservation),
      items: structuredClone(state.reservation.items),
      bundle: { ...state.bundle },
    },
    items: structuredClone(state.order.items),
  });

  const reservation = {
    findUnique: vi.fn(async ({ where }: { where: RecordValue }) => matches(state.reservation, where) ? reservationRecord() : null),
    updateMany: vi.fn(async ({ where, data }: { where: RecordValue; data: RecordValue }) => {
      if (!matches(state.reservation, where)) return { count: 0 };
      apply(state.reservation, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }: { data: RecordValue }) => {
      apply(state.reservation, data);
      return reservationRecord();
    }),
  };
  const order = {
    findUnique: vi.fn(async ({ where }: { where: RecordValue }) => matches(state.order, where) ? orderRecord() : null),
    updateMany: vi.fn(async ({ where, data }: { where: RecordValue; data: RecordValue }) => {
      if (!matches(state.order, where)) return { count: 0 };
      apply(state.order, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }: { data: RecordValue }) => {
      apply(state.order, data);
      return orderRecord();
    }),
  };
  const inventoryLot = {
    findMany: vi.fn(async () => [structuredClone(state.lot)]),
    updateMany: vi.fn(async ({ where, data }: { where: RecordValue; data: RecordValue }) => {
      if (!matches(state.lot, where)) return { count: 0 };
      apply(state.lot, data);
      return { count: 1 };
    }),
  };
  const pickupWindow = {
    updateMany: vi.fn(async ({ where, data }: { where: RecordValue; data: RecordValue }) => {
      if (!matches(state.pickupWindow, where)) return { count: 0 };
      apply(state.pickupWindow, data);
      return { count: 1 };
    }),
  };
  const tx = {
    reservation,
    order,
    inventoryLot,
    pickupWindow,
    bundle: { update: vi.fn(async ({ data }: { data: RecordValue }) => { apply(state.bundle, data); }) },
    auditEvent: { create: vi.fn(async () => ({})) },
    paypalTransaction: { create: vi.fn(async () => ({})) },
    impactMetric: { create: vi.fn(async () => ({})) },
  };
  const db = {
    reservation,
    order,
    inventoryLot,
    pickupWindow,
    $transaction: vi.fn(async (operation: (transaction: typeof tx) => unknown) => operation(tx)),
  };
  return { db, tx };
}

describe("reservation and PayPal capture transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "CREATED" } satisfies Partial<PayPalOrder>);
  });

  it("keeps cancellation final and refuses a stale capture claim after stock is released", async () => {
    const state = fixture();
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("released");
    await expect(claimReservationForCapture("order-1", "reservation-1")).resolves.toBe("not_releasable");

    expect(state.reservation.status).toBe("CANCELLED");
    expect(state.order.status).toBe("CANCELLED");
    expect(state.lot.quantityReserved).toBe(0);
    expect(state.pickupWindow.reservedUnits).toBe(0);
  });

  it("records merchant reconciliation as a merchant actor in the audit trail", async () => {
    const state = fixture();
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);

    await expect(releaseReservation("reservation-1", "CANCELLED", "merchant-user", "MERCHANT")).resolves.toBe("released");

    expect(mocked.tx.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: "merchant-user",
        actorType: "MERCHANT",
        action: "RESERVATION_CANCELLED",
        entityId: "reservation-1",
      }),
    });
  });

  it("lets a capture claim win before release and keeps the stock held", async () => {
    const state = fixture();
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);

    await expect(claimReservationForCapture("order-1", "reservation-1")).resolves.toBe("claimed");
    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("not_releasable");

    expect(state.reservation.status).toBe("PAYMENT_APPROVED");
    expect(state.order.status).toBe("PAYMENT_APPROVED");
    expect(state.lot.quantityReserved).toBe(1);
    expect(state.pickupWindow.reservedUnits).toBe(1);
  });

  it("releases a rejected capture only after PayPal confirms the approved order is voided", async () => {
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_APPROVED",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: new Date(),
        failureCode: null,
        failureSummary: null,
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_APPROVED",
        paymentStatus: "APPROVED",
        amountCents: 500,
        currency: "USD",
        paymentErrorCode: "CAPTURE_REJECTED",
        paymentErrorSummary: "PayPal rejected the capture.",
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("released");

    expect(mocks.getPayPalOrder).toHaveBeenCalledWith("PAYPAL-ORDER-1");
    expect(state.reservation.status).toBe("CANCELLED");
    expect(state.order.status).toBe("CANCELLED");
    expect(state.order.paymentStatus).toBe("FAILED");
    expect(state.lot.quantityReserved).toBe(0);
    expect(state.pickupWindow.reservedUnits).toBe(0);
  });

  it("keeps an approved order held if PayPal still reports APPROVED", async () => {
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_APPROVED",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: new Date(),
        failureCode: null,
        failureSummary: null,
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_APPROVED",
        paymentStatus: "APPROVED",
        amountCents: 500,
        currency: "USD",
        paymentErrorCode: "CAPTURE_REJECTED",
        paymentErrorSummary: "PayPal rejected the capture.",
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "APPROVED" });

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("not_releasable");

    expect(state.reservation.status).toBe("PAYMENT_APPROVED");
    expect(state.order.status).toBe("PAYMENT_APPROVED");
    expect(state.lot.quantityReserved).toBe(1);
    expect(state.pickupWindow.reservedUnits).toBe(1);
    expect(mocked.tx.reservation.updateMany).not.toHaveBeenCalled();
  });

  it("does not release a voided provider order while another capture request owns the claim", async () => {
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_APPROVED",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: new Date(),
        failureCode: null,
        failureSummary: null,
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_APPROVED",
        paymentStatus: "APPROVED",
        amountCents: 500,
        currency: "USD",
        paymentErrorCode: "CAPTURE_REJECTED",
        paymentErrorSummary: "PayPal rejected the capture.",
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });

    await expect(claimReservationForCapture("order-1", "reservation-1")).resolves.toBe("claimed");
    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("not_releasable");

    expect(state.order.paymentErrorCode).toBe("CAPTURE_IN_PROGRESS");
    expect(state.reservation.status).toBe("PAYMENT_APPROVED");
    expect(state.lot.quantityReserved).toBe(1);
  });

  it("releases a stale capture claim only after PayPal confirms VOIDED", async () => {
    const markerTimestamp = new Date(Date.now() - 3 * 60_000);
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_APPROVED",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: new Date(),
        failureCode: null,
        failureSummary: null,
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_APPROVED",
        paymentStatus: "APPROVED",
        amountCents: 500,
        currency: "USD",
        paymentErrorCode: "CAPTURE_IN_PROGRESS",
        paymentErrorSummary: null,
        updatedAt: markerTimestamp,
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("released");

    expect(mocks.getPayPalOrder).toHaveBeenCalledWith("PAYPAL-ORDER-1");
    expect(mocked.tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ paymentErrorCode: "CAPTURE_IN_PROGRESS", updatedAt: markerTimestamp }),
    }));
    expect(state.reservation.status).toBe("CANCELLED");
    expect(state.order.status).toBe("CANCELLED");
    expect(state.lot.quantityReserved).toBe(0);
    expect(state.pickupWindow.reservedUnits).toBe(0);
  });

  it("keeps stock held if the capture marker timestamp changes during provider verification", async () => {
    const markerTimestamp = new Date(Date.now() - 3 * 60_000);
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_APPROVED",
        failureCode: null,
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_APPROVED",
        paymentStatus: "APPROVED",
        paymentErrorCode: "CAPTURE_IN_PROGRESS",
        updatedAt: markerTimestamp,
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockImplementation(async () => {
      state.order.updatedAt = new Date();
      return { id: "PAYPAL-ORDER-1", status: "VOIDED" };
    });

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("not_releasable");

    expect(mocked.tx.reservation.updateMany).not.toHaveBeenCalled();
    expect(mocked.tx.order.updateMany).not.toHaveBeenCalled();
    expect(state.reservation.status).toBe("PAYMENT_APPROVED");
    expect(state.lot.quantityReserved).toBe(1);
    expect(state.pickupWindow.reservedUnits).toBe(1);
  });

  it("keeps a recent capture claim held without querying or releasing stock", async () => {
    const markerTimestamp = new Date(Date.now() - 30_000);
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_APPROVED",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: new Date(),
        failureCode: null,
        failureSummary: null,
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_APPROVED",
        paymentStatus: "APPROVED",
        amountCents: 500,
        currency: "USD",
        paymentErrorCode: "CAPTURE_IN_PROGRESS",
        paymentErrorSummary: null,
        updatedAt: markerTimestamp,
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("not_releasable");

    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
    expect(mocked.tx.reservation.updateMany).not.toHaveBeenCalled();
    expect(state.reservation.status).toBe("PAYMENT_APPROVED");
    expect(state.order.status).toBe("PAYMENT_APPROVED");
    expect(state.lot.quantityReserved).toBe(1);
    expect(state.pickupWindow.reservedUnits).toBe(1);
  });

  it("releases a recoverable capture exception only after PayPal confirms VOIDED", async () => {
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_EXCEPTION",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: new Date(),
        failureCode: "CAPTURE_UNCERTAIN",
        failureSummary: "Capture status could not be confirmed.",
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_EXCEPTION",
        paymentStatus: "UNKNOWN",
        amountCents: 500,
        currency: "USD",
        paymentErrorCode: "CAPTURE_UNCERTAIN",
        paymentErrorSummary: "Capture status could not be confirmed.",
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("released");

    expect(state.reservation.status).toBe("CANCELLED");
    expect(state.reservation.failureCode).toBe("CAPTURE_UNCERTAIN");
    expect(state.order.status).toBe("CANCELLED");
    expect(state.order.paymentStatus).toBe("FAILED");
    expect(state.lot.quantityReserved).toBe(0);
    expect(state.pickupWindow.reservedUnits).toBe(0);
  });

  it("keeps nonrecoverable payment exceptions held even when the provider order is VOIDED", async () => {
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_EXCEPTION",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: new Date(),
        failureCode: "PAYMENT_REVERSED",
        failureSummary: "Capture was denied.",
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_EXCEPTION",
        paymentStatus: "UNKNOWN",
        amountCents: 500,
        currency: "USD",
        paymentErrorCode: "PAYMENT_REVERSED",
        paymentErrorSummary: "Capture was denied.",
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("not_releasable");

    expect(state.reservation.status).toBe("PAYMENT_EXCEPTION");
    expect(state.order.status).toBe("PAYMENT_EXCEPTION");
    expect(state.lot.quantityReserved).toBe(1);
    expect(state.pickupWindow.reservedUnits).toBe(1);
    expect(mocked.tx.reservation.updateMany).not.toHaveBeenCalled();
  });

  it("releases a denied capture exception only when PayPal confirms the order is VOIDED", async () => {
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_EXCEPTION",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: new Date(),
        failureCode: "CAPTURE_DENIED",
        failureSummary: "PayPal denied capture.",
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_EXCEPTION",
        paymentStatus: "DECLINED",
        amountCents: 500,
        currency: "USD",
        paymentErrorCode: "CAPTURE_DENIED",
        paymentErrorSummary: "PayPal denied capture.",
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("released");

    expect(state.reservation.status).toBe("CANCELLED");
    expect(state.reservation.failureCode).toBe("CAPTURE_DENIED");
    expect(state.order.status).toBe("CANCELLED");
    expect(state.order.paymentStatus).toBe("FAILED");
    expect(state.lot.quantityReserved).toBe(0);
    expect(state.pickupWindow.reservedUnits).toBe(0);
  });

  it("keeps a CAPTURE_DENIED exception held when its payment status is not DECLINED", async () => {
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_EXCEPTION",
        failureCode: "CAPTURE_DENIED",
        items: [],
      },
      order: {
        id: "order-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_EXCEPTION",
        paymentStatus: "UNKNOWN",
        paymentErrorCode: "CAPTURE_DENIED",
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("not_releasable");

    expect(mocks.getPayPalOrder).not.toHaveBeenCalled();
    expect(mocked.tx.reservation.updateMany).not.toHaveBeenCalled();
    expect(state.lot.quantityReserved).toBe(1);
    expect(state.pickupWindow.reservedUnits).toBe(1);
  });

  it("keeps a recoverable reservation held when its order exception code disagrees", async () => {
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "PAYMENT_EXCEPTION",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: new Date(),
        failureCode: "CAPTURE_UNCERTAIN",
        failureSummary: "Capture status could not be confirmed.",
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "PAYMENT_EXCEPTION",
        paymentStatus: "UNKNOWN",
        amountCents: 500,
        currency: "USD",
        paymentErrorCode: "DATABASE_FINALIZATION_UNCERTAIN",
        paymentErrorSummary: "Capture status could not be confirmed.",
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);
    mocks.getPayPalOrder.mockResolvedValue({ id: "PAYPAL-ORDER-1", status: "VOIDED" });

    await expect(releaseReservation("reservation-1", "CANCELLED", "shopper-1")).resolves.toBe("not_releasable");

    expect(state.reservation.status).toBe("PAYMENT_EXCEPTION");
    expect(state.order.status).toBe("PAYMENT_EXCEPTION");
    expect(state.lot.quantityReserved).toBe(1);
    expect(state.pickupWindow.reservedUnits).toBe(1);
    expect(mocked.tx.reservation.updateMany).not.toHaveBeenCalled();
  });

  it("does not finalize a cancelled reservation against another buyer's aggregate lot hold", async () => {
    const state = fixture({
      reservation: {
        id: "reservation-1",
        status: "CANCELLED",
        expiresAt: new Date(Date.now() - 60_000),
        userId: "shopper-1",
        storeId: "store-1",
        bundleId: "bundle-1",
        pickupWindowId: "window-1",
        paymentApprovedAt: null,
        failureCode: null,
        failureSummary: null,
        items: [{ id: "reservation-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      order: {
        id: "order-1",
        reservationId: "reservation-1",
        paypalOrderId: "PAYPAL-ORDER-1",
        status: "CANCELLED",
        paymentStatus: "FAILED",
        amountCents: 500,
        currency: "USD",
        storeId: "store-1",
        captureRequestId: "capture-1",
        items: [{ id: "order-item-1", inventoryLotId: "lot-1", quantity: 1, unitPriceCents: 500, originalUnitPriceCents: 1_000 }],
      },
      // This one aggregate reserved unit belongs to a different active reservation.
      lot: { id: "lot-1", quantityOnHand: 2, quantityReserved: 1, quantitySold: 0 },
      pickupWindow: { id: "window-1", reservedUnits: 1 },
      bundle: { id: "bundle-1", status: "CANCELLED" },
    });
    const mocked = mockDb(state);
    mocks.getDb.mockReturnValue(mocked.db);

    const result = await finalizeCapturedPayment({
      orderId: "PAYPAL-ORDER-1",
      captureId: "CAPTURE-1",
      amountCents: 500,
      currency: "USD",
    });

    expect(result).toMatchObject({ status: "PAYMENT_EXCEPTION", reason: "RESERVATION_NOT_ACTIVE" });
    expect(state.reservation.status).toBe("CANCELLED");
    expect(state.order.status).toBe("PAYMENT_EXCEPTION");
    expect(state.lot.quantityReserved).toBe(1);
    expect(state.lot.quantitySold).toBe(0);
    expect(mocked.tx.inventoryLot.findMany).not.toHaveBeenCalled();
  });
});

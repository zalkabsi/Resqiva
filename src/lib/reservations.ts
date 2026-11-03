import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { getPayPalOrder } from "@/lib/paypal";

const RESERVATION_MINUTES = 20;
const SERIALIZATION_RETRIES = 3;

export class ReservationError extends Error {
  constructor(
    readonly code:
      | "BUNDLE_NOT_FOUND"
      | "BUNDLE_UNAVAILABLE"
      | "RESERVATION_EXPIRED"
      | "INSUFFICIENT_STOCK"
      | "PICKUP_UNAVAILABLE"
      | "CAPACITY_UNAVAILABLE"
      | "RESERVATION_NOT_FOUND"
      | "RESERVATION_NOT_CANCELLABLE"
      | "PAYMENT_STATE_UNCERTAIN",
    message: string,
  ) {
    super(message);
    this.name = "ReservationError";
  }
}

export type ReservationReleaseResult = "released" | "already_final" | "not_releasable";

/**
 * Reserve the exact bundle rows saved by the optimizer. Price, quantities,
 * store, and pickup window are read from the database, never from the request.
 */
export async function createReservationForBundle(bundleId: string, userId: string) {
  const db = getDb();
  const existing = await db.reservation.findUnique({
    where: { bundleId },
    include: { order: true, items: true, pickupWindow: true },
  });
  if (existing) {
    if (existing.userId !== userId) throw new ReservationError("BUNDLE_UNAVAILABLE", "This meal set is no longer available.");
    if (existing.status === "RESERVED" && existing.expiresAt > new Date()) return existing;
    throw new ReservationError("BUNDLE_UNAVAILABLE", "This meal set already has a reservation that is no longer active.");
  }

  try {
    return await withSerializableRetry(async () => db.$transaction(async (tx) => {
      const bundle = await tx.bundle.findUnique({
        where: { id: bundleId },
        include: {
          items: { include: { inventoryLot: true } },
          store: true,
          pickupWindow: true,
          reservation: true,
        },
      });
      if (!bundle || bundle.store.isDemo !== true) {
        throw new ReservationError("BUNDLE_NOT_FOUND", "The meal set could not be found. Please plan again.");
      }
      if (bundle.userId !== userId || bundle.status !== "PENDING" || bundle.reservation) {
        throw new ReservationError("BUNDLE_UNAVAILABLE", "This meal set is no longer available. Please plan again.");
      }
      if (bundle.createdAt.getTime() < Date.now() - 30 * 60_000) {
        throw new ReservationError("RESERVATION_EXPIRED", "This meal plan is more than 30 minutes old. Please check current stock again.");
      }
      if (!bundle.pickupWindow || !bundle.pickupWindow.active || bundle.pickupWindow.endsAt <= new Date()) {
        throw new ReservationError("PICKUP_UNAVAILABLE", "The pickup window has ended. Please choose another pickup day.");
      }
      const pickupWindow = bundle.pickupWindow;
      const pickupWindowId = pickupWindow.id;
      if (bundle.items.length === 0) {
        throw new ReservationError("BUNDLE_UNAVAILABLE", "This meal set has no listed items. Please plan again.");
      }

      const quantityTotal = bundle.items.reduce((sum, item) => sum + item.quantity, 0);
      if (pickupWindow.reservedUnits + quantityTotal > pickupWindow.capacityUnits) {
        throw new ReservationError("CAPACITY_UNAVAILABLE", "There is not enough pickup capacity in this window.");
      }
      for (const item of bundle.items) {
        const available = item.inventoryLot.quantityOnHand
          - item.inventoryLot.quantityReserved
          - item.inventoryLot.quantitySold;
        if (!item.inventoryLot.sellable || item.quantity < 1 || available < item.quantity) {
          throw new ReservationError("INSUFFICIENT_STOCK", "Some items are no longer available in the requested quantities. Please plan again.");
        }
        if (
          item.inventoryLot.expiresAt
          && item.inventoryLot.expiresAt < bundle.pickupWindow.endsAt
        ) {
          throw new ReservationError("BUNDLE_UNAVAILABLE", "An item will not remain within its listed date through pickup. Please plan again.");
        }
      }

      for (const item of bundle.items) {
        const result = await tx.inventoryLot.updateMany({
          where: {
            id: item.inventoryLotId,
            quantityOnHand: { gte: item.inventoryLot.quantityReserved + item.inventoryLot.quantitySold + item.quantity },
            sellable: true,
          },
          data: { quantityReserved: { increment: item.quantity } },
        });
        if (result.count !== 1) {
          throw new ReservationError("INSUFFICIENT_STOCK", "Some items were reserved by another customer. Please plan again.");
        }
      }

      const capacity = await tx.pickupWindow.updateMany({
        where: {
        id: pickupWindowId,
          active: true,
          endsAt: { gt: new Date() },
          reservedUnits: { lte: pickupWindow.capacityUnits - quantityTotal },
        },
        data: { reservedUnits: { increment: quantityTotal } },
      });
      if (capacity.count !== 1) {
        throw new ReservationError("CAPACITY_UNAVAILABLE", "There is not enough pickup capacity in this window.");
      }

      const reservation = await tx.reservation.create({
        data: {
          idempotencyKey: `bundle:${bundle.id}`,
          bundleId: bundle.id,
          userId,
          storeId: bundle.storeId,
          pickupWindowId,
          status: "RESERVED",
          expiresAt: new Date(Date.now() + RESERVATION_MINUTES * 60_000),
          reservedAt: new Date(),
          items: {
            create: bundle.items.map((item) => ({
              inventoryLotId: item.inventoryLotId,
              quantity: item.quantity,
              unitPriceCents: item.unitPriceCents,
              originalUnitPriceCents: item.originalUnitPriceCents,
            })),
          },
        },
        include: { items: true, pickupWindow: true },
      });

      await tx.bundle.update({ where: { id: bundle.id }, data: { status: "RESERVED" } });
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          actorType: "CUSTOMER",
          action: "RESERVATION_CREATED",
          entityType: "Reservation",
          entityId: reservation.id,
          requestId: randomUUID(),
          metadata: { itemCount: reservation.items.length, expiresAt: reservation.expiresAt.toISOString() },
        },
      });
      return reservation;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isUniqueConstraintError(error) || (error instanceof ReservationError && error.code === "BUNDLE_UNAVAILABLE")) {
      const raced = await db.reservation.findUnique({
        where: { bundleId },
        include: { order: true, items: true, pickupWindow: true },
      });
      if (raced?.userId === userId && raced.status === "RESERVED" && raced.expiresAt > new Date()) return raced;
      throw new ReservationError("BUNDLE_UNAVAILABLE", "This meal set is no longer available. Please plan again.");
    }
    throw error;
  }
}

/**
 * Release inventory only after a remote order check shows no completed capture.
 * Any provider/network uncertainty keeps the reservation and stock held.
 */
export async function releaseReservation(
  reservationId: string,
  terminalStatus: "CANCELLED" | "EXPIRED",
  actorUserId?: string,
): Promise<ReservationReleaseResult> {
  const db = getDb();
  const current = await db.reservation.findUnique({
    where: { id: reservationId },
    include: { order: true, items: true, pickupWindow: true },
  });
  if (!current) throw new ReservationError("RESERVATION_NOT_FOUND", "The reservation could not be found.");
  if (current.status === terminalStatus || current.status === "CANCELLED" || current.status === "EXPIRED") {
    return "already_final";
  }
  if (current.status !== "RESERVED") return "not_releasable";

  if (current.order?.paypalOrderId) {
    try {
      const remote = await getPayPalOrder(current.order.paypalOrderId);
      // Only an unapproved CREATED or definitively VOIDED provider order is
      // safe to release. Unknown and approved states keep inventory held.
      if (remote.status !== "CREATED" && remote.status !== "VOIDED") return "not_releasable";
    } catch {
      // A timeout or invalid credential cannot prove that a capture did not complete.
      return "not_releasable";
    }
  }
  if (current.order && (
    current.order.paymentStatus === "CAPTURED"
    || current.order.paymentStatus === "APPROVED"
    || current.order.status === "PAID"
    || current.order.status === "PAYMENT_APPROVED"
  )) {
    return "not_releasable";
  }
  if (current.order?.status === "PAYMENT_EXCEPTION" || current.order?.paymentStatus === "UNKNOWN") {
    return "not_releasable";
  }

  try {
    return await withSerializableRetry(async () => db.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        include: { items: true, order: true },
      });
      if (!reservation) throw new ReservationError("RESERVATION_NOT_FOUND", "The reservation could not be found.");
      if (reservation.status === terminalStatus || reservation.status === "CANCELLED" || reservation.status === "EXPIRED") {
        return "already_final" as const;
      }
      if (reservation.status !== "RESERVED") return "not_releasable" as const;
      if (reservation.order && (
        reservation.order.status === "PAID"
        || reservation.order.status === "PAYMENT_APPROVED"
        || reservation.order.status === "PAYMENT_EXCEPTION"
        || reservation.order.paymentStatus === "CAPTURED"
        || reservation.order.paymentStatus === "APPROVED"
        || reservation.order.paymentStatus === "UNKNOWN"
      )) return "not_releasable" as const;

      const totalUnits = reservation.items.reduce((sum, item) => sum + item.quantity, 0);
      for (const item of reservation.items) {
        const updated = await tx.inventoryLot.updateMany({
          where: { id: item.inventoryLotId, quantityReserved: { gte: item.quantity } },
          data: { quantityReserved: { decrement: item.quantity } },
        });
        if (updated.count !== 1) throw new Error("Reservation stock accounting is inconsistent.");
      }
      const pickup = await tx.pickupWindow.updateMany({
        where: { id: reservation.pickupWindowId, reservedUnits: { gte: totalUnits } },
        data: { reservedUnits: { decrement: totalUnits } },
      });
      if (pickup.count !== 1) throw new Error("Reservation pickup capacity accounting is inconsistent.");

      await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          status: terminalStatus,
          cancelledAt: terminalStatus === "CANCELLED" ? new Date() : undefined,
          releasedAt: new Date(),
        },
      });
      await tx.bundle.update({ where: { id: reservation.bundleId }, data: { status: terminalStatus } });
      if (reservation.order && reservation.order.status === "PENDING") {
        await tx.order.update({
          where: { id: reservation.order.id },
          data: { status: terminalStatus, paymentStatus: "FAILED" },
        });
      }
      await tx.auditEvent.create({
        data: {
          actorUserId: actorUserId ?? null,
          actorType: actorUserId ? "CUSTOMER" : "SYSTEM",
          action: terminalStatus === "CANCELLED" ? "RESERVATION_CANCELLED" : "RESERVATION_EXPIRED",
          entityType: "Reservation",
          entityId: reservation.id,
          requestId: randomUUID(),
          metadata: { itemCount: reservation.items.length },
        },
      });
      return "released" as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isSerializationConflict(error)) return "not_releasable";
    throw error;
  }
}

/** Expire stale unapproved reservations before creating new plans or holds. */
export async function expireStaleReservations(): Promise<void> {
  const db = getDb();
  const expired = await db.reservation.findMany({
    where: { status: "RESERVED", expiresAt: { lte: new Date() } },
    select: { id: true },
    take: 50,
  });
  for (const reservation of expired) {
    try {
      await releaseReservation(reservation.id, "EXPIRED");
    } catch {
      // Keep unknown states and inventory held; the next request can retry reconciliation.
    }
  }
}

async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationConflict(error) || attempt >= SERIALIZATION_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

function isSerializationConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2034" || code === "40001";
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

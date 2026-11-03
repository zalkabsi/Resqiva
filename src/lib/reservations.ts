import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { getPayPalOrder } from "@/lib/paypal";

const RESERVATION_MINUTES = 20;
const SERIALIZATION_RETRIES = 3;
// The capture route has a 30 second maximum duration. Keep an in-flight claim
// held substantially longer before treating it as abandoned after a crash.
const CAPTURE_IN_PROGRESS_LEASE_MS = 2 * 60_000;

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
export type CaptureClaimResult = "claimed" | "not_found" | "not_releasable";

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
  actorType?: "CUSTOMER" | "MERCHANT",
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
  const isUnapprovedReservation = current.status === "RESERVED";
  const isApprovedReservation = current.status === "PAYMENT_APPROVED";
  const isRecoverableException = current.status === "PAYMENT_EXCEPTION"
    && ["CAPTURE_UNCERTAIN", "DATABASE_FINALIZATION_UNCERTAIN", "CAPTURE_DENIED"].includes(current.failureCode ?? "");
  if (!isUnapprovedReservation && !isApprovedReservation && !isRecoverableException) return "not_releasable";

  const hasCaptureInProgress = isApprovedReservation
    && current.order?.paymentErrorCode === "CAPTURE_IN_PROGRESS";
  const staleCaptureInProgress = hasCaptureInProgress && isStaleCaptureInProgress(current.order);
  // A recent marker may belong to a still-running capture request. An old
  // marker is recoverable only after PayPal independently reports VOIDED.
  if (hasCaptureInProgress && !staleCaptureInProgress) return "not_releasable";

  let verifiedProviderStatus: string | null = null;
  if ((isApprovedReservation || isRecoverableException) && !current.order?.paypalOrderId) return "not_releasable";
  if (isRecoverableException && (
    !current.order
    || current.order.status !== "PAYMENT_EXCEPTION"
    || current.order.paymentStatus !== expectedExceptionPaymentStatus(current.failureCode)
    || current.order.paymentErrorCode !== current.failureCode
  )) return "not_releasable";
  if (current.order?.paypalOrderId) {
    try {
      const remote = await getPayPalOrder(current.order.paypalOrderId);
      verifiedProviderStatus = remote.status;
      // Only an unapproved CREATED or definitively VOIDED provider order is
      // safe to release. For an approved local order, require a fresh VOIDED
      // status from PayPal. APPROVED and every other state remain held.
      if (isApprovedReservation || isRecoverableException) {
        if (remote.status !== "VOIDED") return "not_releasable";
      } else if (remote.status !== "CREATED" && remote.status !== "VOIDED") {
        return "not_releasable";
      }
    } catch {
      // A timeout or invalid credential cannot prove that a capture did not complete.
      return "not_releasable";
    }
  }
  if (isUnapprovedReservation && current.order && (
    current.order.status !== "PENDING"
    || (current.order.paymentStatus !== "CREATED" && current.order.paymentStatus !== "FAILED")
  )) {
    return "not_releasable";
  }
  if (isApprovedReservation && (
    !current.order
    || current.order.status !== "PAYMENT_APPROVED"
    || current.order.paymentStatus !== "APPROVED"
    || (current.order.paymentErrorCode === "CAPTURE_IN_PROGRESS" && !staleCaptureInProgress)
  )) {
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
      if (reservation.status !== current.status) return "not_releasable" as const;
      // The provider status was read before this transaction. If order creation
      // or another payment transition changed the order since then, require a
      // fresh attempt instead of releasing stock against stale provider state.
      if ((current.order?.id ?? null) !== (reservation.order?.id ?? null)) return "not_releasable" as const;
      if (current.order && (
        reservation.order?.paypalOrderId !== current.order.paypalOrderId
        || reservation.order.status !== current.order.status
        || reservation.order.paymentStatus !== current.order.paymentStatus
        || reservation.order.paymentErrorCode !== current.order.paymentErrorCode
        || (current.order.paymentErrorCode === "CAPTURE_IN_PROGRESS"
          && !sameTimestamp(reservation.order?.updatedAt, current.order.updatedAt))
      )) return "not_releasable" as const;
      if (reservation.status === "RESERVED" && reservation.order && (
        reservation.order.status !== "PENDING"
        || (reservation.order.paymentStatus !== "CREATED" && reservation.order.paymentStatus !== "FAILED")
      )) return "not_releasable" as const;
      if (reservation.status === "PAYMENT_APPROVED" && (
        !reservation.order
        || !reservation.order.paypalOrderId
        || reservation.order.status !== "PAYMENT_APPROVED"
        || reservation.order.paymentStatus !== "APPROVED"
        || (reservation.order.paymentErrorCode === "CAPTURE_IN_PROGRESS"
          && !isStaleCaptureInProgress(reservation.order))
        || verifiedProviderStatus !== "VOIDED"
      )) return "not_releasable" as const;
      if (reservation.status === "PAYMENT_EXCEPTION" && (
        !["CAPTURE_UNCERTAIN", "DATABASE_FINALIZATION_UNCERTAIN", "CAPTURE_DENIED"].includes(reservation.failureCode ?? "")
        || !reservation.order
        || !reservation.order.paypalOrderId
        || reservation.order.status !== "PAYMENT_EXCEPTION"
        || reservation.order.paymentStatus !== expectedExceptionPaymentStatus(reservation.failureCode)
        || reservation.order.paymentErrorCode !== reservation.failureCode
        || reservation.failureCode !== current.failureCode
        || verifiedProviderStatus !== "VOIDED"
      )) return "not_releasable" as const;

      const now = new Date();
      const reservationClaim = await tx.reservation.updateMany({
        where: {
          id: reservation.id,
          status: reservation.status,
          ...(reservation.status === "PAYMENT_EXCEPTION" ? { failureCode: current.failureCode } : {}),
          ...(terminalStatus === "EXPIRED" ? { expiresAt: { lte: now } } : {}),
        },
        data: {
          status: terminalStatus,
          cancelledAt: terminalStatus === "CANCELLED" ? now : undefined,
          releasedAt: now,
        },
      });
      if (reservationClaim.count !== 1) return "not_releasable" as const;

      if (reservation.order) {
        const orderClaim = await tx.order.updateMany({
          where: {
            id: reservation.order.id,
            status: reservation.status === "RESERVED" ? "PENDING" : reservation.order.status,
            paymentStatus: reservation.status === "RESERVED"
              ? { in: ["CREATED", "FAILED"] }
              : reservation.order.paymentStatus,
            paypalOrderId: reservation.order.paypalOrderId,
            paymentErrorCode: reservation.order.paymentErrorCode,
            ...(current.order?.paymentErrorCode === "CAPTURE_IN_PROGRESS"
              ? { updatedAt: current.order.updatedAt }
              : {}),
          },
          data: { status: terminalStatus, paymentStatus: "FAILED" },
        });
        if (orderClaim.count !== 1) throw new ReservationTransitionRaceError();
      }

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

      await tx.bundle.update({ where: { id: reservation.bundleId }, data: { status: terminalStatus } });
      await tx.auditEvent.create({
        data: {
          actorUserId: actorUserId ?? null,
          actorType: actorType ?? (actorUserId ? "CUSTOMER" : "SYSTEM"),
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
    if (error instanceof ReservationTransitionRaceError) return "not_releasable";
    if (isSerializationConflict(error)) return "not_releasable";
    throw error;
  }
}

function expectedExceptionPaymentStatus(failureCode: string | null): "DECLINED" | "UNKNOWN" {
  // PayPal's PAYMENT.CAPTURE.DENIED webhook records DECLINED; uncertain
  // network/finalization outcomes retain UNKNOWN.
  return failureCode === "CAPTURE_DENIED" ? "DECLINED" : "UNKNOWN";
}

function isStaleCaptureInProgress(order: { updatedAt?: Date | null } | null | undefined): boolean {
  const updatedAt = order?.updatedAt;
  return updatedAt instanceof Date
    && Number.isFinite(updatedAt.getTime())
    && Date.now() - updatedAt.getTime() >= CAPTURE_IN_PROGRESS_LEASE_MS;
}

function sameTimestamp(left: Date | null | undefined, right: Date | null | undefined): boolean {
  return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
}

/**
 * Claim an active reservation for capture before making the external PayPal
 * request. The conditional state transition serializes against cancellation:
 * if cancellation commits first, this function cannot move it back to an
 * approvable state. Repeated capture requests may share the same approved
 * claim and PayPal request idempotency key.
 */
export async function claimReservationForCapture(
  orderId: string,
  reservationId: string,
): Promise<CaptureClaimResult> {
  const db = getDb();
  try {
    return await withSerializableRetry(async () => db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { reservation: true },
      });
      if (!order || order.reservationId !== reservationId) return "not_found" as const;

      const reservation = order.reservation;
      const alreadyApproved = reservation.status === "PAYMENT_APPROVED"
        && order.status === "PAYMENT_APPROVED"
        && order.paymentStatus === "APPROVED";
      if (alreadyApproved && order.paymentErrorCode === "CAPTURE_IN_PROGRESS") {
        // Duplicate capture requests share the current in-flight attempt. Its
        // marker also prevents a concurrent VOIDED-order cancellation from
        // releasing stock while the provider request is outstanding.
        return "claimed" as const;
      }

      const retryableApproved = alreadyApproved && order.paymentErrorCode !== "CAPTURE_IN_PROGRESS";
      const activeReservation = reservation.status === "RESERVED" && reservation.expiresAt > new Date();
      const retryableException = reservation.status === "PAYMENT_EXCEPTION"
        && ["CAPTURE_UNCERTAIN", "DATABASE_FINALIZATION_UNCERTAIN"].includes(reservation.failureCode ?? "");
      if (!activeReservation && !retryableException && !retryableApproved) return "not_releasable" as const;
      if (
        (activeReservation && !["PENDING", "PAYMENT_APPROVED"].includes(order.status))
        || (retryableException && order.status !== "PAYMENT_EXCEPTION")
        || (retryableApproved && (order.status !== "PAYMENT_APPROVED" || order.paymentStatus !== "APPROVED"))
      ) return "not_releasable" as const;

      const now = new Date();
      const reservationClaim = await tx.reservation.updateMany({
        where: {
          id: reservation.id,
          status: reservation.status,
          ...(activeReservation
            ? { expiresAt: { gt: now } }
            : retryableException
              ? { failureCode: { in: ["CAPTURE_UNCERTAIN", "DATABASE_FINALIZATION_UNCERTAIN"] } }
              : {}),
        },
        data: {
          status: "PAYMENT_APPROVED",
          paymentApprovedAt: reservation.paymentApprovedAt ?? now,
          failureCode: null,
          failureSummary: null,
        },
      });
      if (reservationClaim.count !== 1) throw new ReservationTransitionRaceError();

      const captureRequestId = order.captureRequestId ?? `resqiva-capture-${order.id}`;
      const orderClaim = await tx.order.updateMany({
        where: {
          id: order.id,
          status: order.status,
          paymentStatus: order.paymentStatus,
          paymentErrorCode: order.paymentErrorCode,
        },
        data: {
          status: "PAYMENT_APPROVED",
          paymentStatus: "APPROVED",
          captureRequestId,
          paymentErrorCode: "CAPTURE_IN_PROGRESS",
          paymentErrorSummary: null,
        },
      });
      if (orderClaim.count !== 1) throw new ReservationTransitionRaceError();
      return "claimed" as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (error instanceof ReservationTransitionRaceError || isSerializationConflict(error)) return "not_releasable";
    throw error;
  }
}

class ReservationTransitionRaceError extends Error {}

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

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authorizeDemoMerchant, sameOriginRequired } from "@/lib/merchant-auth";
import { checkMerchantMutationLimit, merchantRateLimitResponse } from "@/lib/merchant-mutation-limit";
import { readJsonLimited, RequestReadError } from "@/lib/request";
import {
  findOverlap,
  parseWindowDate,
  updatePickupWindowSchema,
  validateWindowUpdate,
} from "@/lib/pickup-window-rules";

export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 8 * 1024;

type RouteContext = { params: Promise<{ windowId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const originError = sameOriginRequired(request);
  if (originError) return originError;
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;

  const { windowId } = await context.params;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(windowId)) {
    return NextResponse.json({ error: "Pickup-window reference is invalid." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await readJsonLimited(request, MAX_REQUEST_BYTES);
  } catch (error) {
    const tooLarge = error instanceof RequestReadError && error.status === 413;
    return NextResponse.json({ error: tooLarge ? "Request body is too large." : "Request body must be valid JSON." }, { status: tooLarge ? 413 : 400 });
  }
  const parsed = updatePickupWindowSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Pickup-window changes are invalid." }, { status: 400 });

  const schedulePatch = {
    startsAt: parsed.data.startsAt ? parseWindowDate(parsed.data.startsAt) : undefined,
    endsAt: parsed.data.endsAt ? parseWindowDate(parsed.data.endsAt) : undefined,
    lastReservationAt: parsed.data.lastReservationAt ? parseWindowDate(parsed.data.lastReservationAt) : undefined,
  };
  if (Object.values(schedulePatch).some((date) => date === null)) {
    return NextResponse.json({ error: "Pickup times must be valid ISO date-times with explicit timezones." }, { status: 400 });
  }

  try {
    const db = getDb();
    const { merchantId, userId } = authorization.context;
    const result = await db.$transaction(async (tx) => {
      const existing = await tx.pickupWindow.findFirst({
        where: { id: windowId, store: { merchantId, isDemo: true } },
        include: { store: { select: { name: true, city: true, timezone: true } } },
      });
      if (!existing) return { kind: "missing" as const };
      const rateLimit = checkMerchantMutationLimit(userId, "pickup-window-update", 30);
      if (!rateLimit.allowed) return { kind: "rate_limited" as const, retryAfterSeconds: rateLimit.retryAfterSeconds };

      const [liveReservations, liveOrders] = await Promise.all([
        tx.reservation.count({
          where: {
            pickupWindowId: existing.id,
            status: { in: ["PENDING", "RESERVED", "PAYMENT_APPROVED", "PAID", "PAYMENT_EXCEPTION"] },
          },
        }),
        tx.order.count({
          where: {
            pickupWindowId: existing.id,
            status: { in: ["PENDING", "PAYMENT_APPROVED", "PAID", "PAYMENT_EXCEPTION"] },
          },
        }),
      ]);

      const next = {
        startsAt: schedulePatch.startsAt ?? existing.startsAt,
        endsAt: schedulePatch.endsAt ?? existing.endsAt,
        lastReservationAt: schedulePatch.lastReservationAt ?? existing.lastReservationAt,
        capacityUnits: parsed.data.capacityUnits ?? existing.capacityUnits,
        reservedUnits: existing.reservedUnits,
        active: parsed.data.active ?? existing.active,
      };
      const validationError = validateWindowUpdate(
        existing,
        next,
        { liveReservations, liveOrders },
      );
      if (validationError) return { kind: "invalid" as const, error: validationError };

      if (next.active) {
        const overlaps = await tx.pickupWindow.findMany({
          where: {
            storeId: existing.storeId,
            active: true,
            id: { not: existing.id },
            startsAt: { lt: next.endsAt },
            endsAt: { gt: next.startsAt },
          },
          select: { id: true, startsAt: true, endsAt: true, lastReservationAt: true },
        });
        if (findOverlap(next, overlaps, existing.id)) return { kind: "overlap" as const };
      }

      const updatedCount = await tx.pickupWindow.updateMany({
        where: {
          id: existing.id,
          storeId: existing.storeId,
          reservedUnits: existing.reservedUnits,
          capacityUnits: existing.capacityUnits,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          lastReservationAt: existing.lastReservationAt,
          active: existing.active,
        },
        data: {
          startsAt: next.startsAt,
          endsAt: next.endsAt,
          lastReservationAt: next.lastReservationAt,
          capacityUnits: next.capacityUnits,
          active: next.active,
        },
      });
      if (updatedCount.count !== 1) return { kind: "raced" as const };

      const updated = await tx.pickupWindow.findUniqueOrThrow({
        where: { id: existing.id },
        include: { store: { select: { name: true, city: true, timezone: true } } },
      });
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          actorType: "MERCHANT",
          action: "DEMO_PICKUP_WINDOW_UPDATED",
          entityType: "PickupWindow",
          entityId: existing.id,
          metadata: {
            capacityUnits: updated.capacityUnits,
            active: updated.active,
            scheduleChanged: updated.startsAt.getTime() !== existing.startsAt.getTime()
              || updated.endsAt.getTime() !== existing.endsAt.getTime()
              || updated.lastReservationAt.getTime() !== existing.lastReservationAt.getTime(),
          },
        },
      });
      return { kind: "updated" as const, window: updated };
    }, { isolationLevel: "Serializable" });

    if (result.kind === "missing") return NextResponse.json({ error: "Pickup window was not found for this demo merchant." }, { status: 404 });
    if (result.kind === "invalid") return NextResponse.json({ error: result.error }, { status: 409 });
    if (result.kind === "rate_limited") return merchantRateLimitResponse("pickup-window-update", result.retryAfterSeconds);
    if (result.kind === "overlap") return NextResponse.json({ error: "This pickup window overlaps another active window at the same store." }, { status: 409 });
    if (result.kind === "raced") return NextResponse.json({ error: "Pickup window changed during this update. Refresh and retry." }, { status: 409 });
    const window = result.window;
    return NextResponse.json({
      pickupWindow: {
        id: window.id,
        storeId: window.storeId,
        storeName: window.store.name,
        city: window.store.city,
        timezone: window.store.timezone,
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt.toISOString(),
        lastReservationAt: window.lastReservationAt.toISOString(),
        capacityUnits: window.capacityUnits,
        reservedUnits: window.reservedUnits,
        remainingCapacity: Math.max(0, window.capacityUnits - window.reservedUnits),
        active: window.active,
      },
    });
  } catch (error) {
    if (isSerializationConflict(error)) return NextResponse.json({ error: "Pickup schedule changed during this update. Refresh and retry." }, { status: 409 });
    return NextResponse.json({ error: "Pickup window could not be updated." }, { status: 503 });
  }
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034";
}

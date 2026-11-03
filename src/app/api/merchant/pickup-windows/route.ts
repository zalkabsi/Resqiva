import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authorizeDemoMerchant, sameOriginRequired } from "@/lib/merchant-auth";
import { checkMerchantMutationLimit, merchantRateLimitResponse } from "@/lib/merchant-mutation-limit";
import { readJsonLimited, RequestReadError } from "@/lib/request";
import {
  createPickupWindowSchema,
  findOverlap,
  parseWindowDate,
  validateWindowSchedule,
} from "@/lib/pickup-window-rules";

export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 8 * 1024;

export async function GET(request: Request) {
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;

  try {
    const windows = await getDb().pickupWindow.findMany({
      where: { store: { merchantId: authorization.context.merchantId, isDemo: true } },
      include: { store: { select: { id: true, name: true, city: true, timezone: true } } },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    });
    return NextResponse.json({
      pickupWindows: windows.map((window) => ({
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
      })),
    });
  } catch {
    return NextResponse.json({ error: "Pickup windows could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const originError = sameOriginRequired(request);
  if (originError) return originError;
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;

  let body: unknown;
  try {
    body = await readJsonLimited(request, MAX_REQUEST_BYTES);
  } catch (error) {
    const tooLarge = error instanceof RequestReadError && error.status === 413;
    return NextResponse.json({ error: tooLarge ? "Request body is too large." : "Request body must be valid JSON." }, { status: tooLarge ? 413 : 400 });
  }
  const parsed = createPickupWindowSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Pickup-window details are invalid." }, { status: 400 });

  const startsAt = parseWindowDate(parsed.data.startsAt);
  const endsAt = parseWindowDate(parsed.data.endsAt);
  const lastReservationAt = parseWindowDate(parsed.data.lastReservationAt);
  if (!startsAt || !endsAt || !lastReservationAt) {
    return NextResponse.json({ error: "Pickup times must be valid ISO date-times with explicit timezones." }, { status: 400 });
  }
  const schedule = { startsAt, endsAt, lastReservationAt };
  const scheduleError = validateWindowSchedule(schedule);
  if (scheduleError) return NextResponse.json({ error: scheduleError }, { status: 400 });

  try {
    const db = getDb();
    const { merchantId, userId } = authorization.context;
    const store = await db.store.findFirst({
      where: { id: parsed.data.storeId, merchantId, isDemo: true },
      select: { id: true },
    });
    if (!store) return NextResponse.json({ error: "The selected store is not owned by this demo merchant." }, { status: 403 });
    const rateLimit = checkMerchantMutationLimit(authorization.context.userId, "pickup-window-create", 10);
    if (!rateLimit.allowed) return merchantRateLimitResponse("pickup-window-create", rateLimit.retryAfterSeconds);

    const window = await db.$transaction(async (tx) => {
      const overlaps = await tx.pickupWindow.findMany({
        where: {
          storeId: store.id,
          active: true,
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
        select: { id: true, startsAt: true, endsAt: true, lastReservationAt: true },
      });
      if (findOverlap(schedule, overlaps)) return null;

      const created = await tx.pickupWindow.create({
        data: {
          storeId: store.id,
          windowKey: `merchant-${randomUUID()}`,
          startsAt,
          endsAt,
          lastReservationAt,
          capacityUnits: parsed.data.capacityUnits,
          reservedUnits: 0,
          active: true,
        },
        include: { store: { select: { name: true, city: true, timezone: true } } },
      });
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          actorType: "MERCHANT",
          action: "DEMO_PICKUP_WINDOW_CREATED",
          entityType: "PickupWindow",
          entityId: created.id,
          metadata: { capacityUnits: created.capacityUnits },
        },
      });
      return created;
    }, { isolationLevel: "Serializable" });

    if (!window) return NextResponse.json({ error: "This pickup window overlaps another active window at the same store." }, { status: 409 });
    return NextResponse.json({ pickupWindow: serializeWindow(window) }, { status: 201 });
  } catch (error) {
    if (isSerializationConflict(error)) return NextResponse.json({ error: "Pickup schedule changed during creation. Refresh and retry." }, { status: 409 });
    return NextResponse.json({ error: "Pickup window could not be created." }, { status: 503 });
  }
}

function serializeWindow(window: {
  id: string;
  storeId: string;
  startsAt: Date;
  endsAt: Date;
  lastReservationAt: Date;
  capacityUnits: number;
  reservedUnits: number;
  active: boolean;
  store: { name: string; city: string; timezone: string };
}) {
  return {
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
  };
}

function isSerializationConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2034";
}

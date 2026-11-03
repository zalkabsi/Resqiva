import { describe, expect, it } from "vitest";
import {
  createPickupWindowSchema,
  findOverlap,
  updatePickupWindowSchema,
  validateWindowSchedule,
  validateWindowUpdate,
  type ExistingWindowState,
} from "@/lib/pickup-window-rules";

const now = new Date("2026-11-03T09:00:00.000Z");
const validInput = {
  storeId: "store_demo_123",
  startsAt: "2026-11-04T12:00:00+03:00",
  endsAt: "2026-11-04T14:00:00+03:00",
  lastReservationAt: "2026-11-04T11:00:00+03:00",
  capacityUnits: 25,
};

describe("pickup window input validation", () => {
  it("accepts explicit-offset date-times and bounded capacity", () => {
    expect(createPickupWindowSchema.safeParse(validInput).success).toBe(true);
  });

  it("rejects date-times without a timezone", () => {
    expect(createPickupWindowSchema.safeParse({ ...validInput, startsAt: "2026-11-04T12:00:00" }).success).toBe(false);
  });

  it("rejects extra client-controlled state such as reserved units", () => {
    expect(createPickupWindowSchema.safeParse({ ...validInput, reservedUnits: 0 }).success).toBe(false);
    expect(updatePickupWindowSchema.safeParse({ reservedUnits: 0 }).success).toBe(false);
  });

  it("requires at least one editable field", () => {
    expect(updatePickupWindowSchema.safeParse({}).success).toBe(false);
  });
});

describe("pickup schedule safety rules", () => {
  it("requires a future start, end after start, and cutoff no later than start", () => {
    const startsAt = new Date("2026-11-04T09:00:00.000Z");
    const endsAt = new Date("2026-11-04T11:00:00.000Z");
    const cutoff = new Date("2026-11-04T08:30:00.000Z");
    expect(validateWindowSchedule({ startsAt, endsAt, lastReservationAt: cutoff }, now)).toBeNull();
    expect(validateWindowSchedule({ startsAt, endsAt: startsAt, lastReservationAt: cutoff }, now)).toContain("end after");
    expect(validateWindowSchedule({ startsAt, endsAt, lastReservationAt: endsAt }, now)).toContain("cutoff");
    expect(validateWindowSchedule({ startsAt: now, endsAt, lastReservationAt: new Date(now.getTime() - 60_000) }, now)).toContain("future");
  });

  it("detects overlap while allowing windows that meet at an endpoint", () => {
    const first = {
      startsAt: new Date("2026-11-04T09:00:00.000Z"),
      endsAt: new Date("2026-11-04T10:00:00.000Z"),
      lastReservationAt: new Date("2026-11-04T08:30:00.000Z"),
    };
    const next = {
      startsAt: new Date("2026-11-04T10:00:00.000Z"),
      endsAt: new Date("2026-11-04T11:00:00.000Z"),
      lastReservationAt: new Date("2026-11-04T09:30:00.000Z"),
    };
    expect(findOverlap(next, [{ ...first, id: "a" }])).toBeUndefined();
    expect(findOverlap({ ...next, startsAt: new Date("2026-11-04T09:30:00.000Z") }, [{ ...first, id: "a" }])?.id).toBe("a");
  });

  it("never lowers capacity below already reserved units", () => {
    const existing = windowState({ reservedUnits: 8, capacityUnits: 20 });
    expect(validateWindowUpdate(existing, { ...existing, capacityUnits: 7 }, { liveReservations: 1, liveOrders: 0 }, now)).toContain("reserved");
    expect(validateWindowUpdate(existing, { ...existing, capacityUnits: 8 }, { liveReservations: 1, liveOrders: 0 }, now)).toBeNull();
  });

  it("refuses schedule edits and deactivation with active reservations or orders", () => {
    const existing = windowState();
    const moved = { ...existing, startsAt: new Date("2026-11-05T09:00:00.000Z") };
    expect(validateWindowUpdate(existing, moved, { liveReservations: 1, liveOrders: 0 }, now)).toContain("active reservations");
    expect(validateWindowUpdate(existing, { ...existing, active: false }, { liveReservations: 0, liveOrders: 1 }, now)).toContain("deactivated");
  });

  it("allows schedule edits when no live reservations or orders exist", () => {
    const existing = windowState();
    const moved = {
      ...existing,
      startsAt: new Date("2026-11-05T09:00:00.000Z"),
      endsAt: new Date("2026-11-05T11:00:00.000Z"),
      lastReservationAt: new Date("2026-11-05T08:30:00.000Z"),
    };
    expect(validateWindowUpdate(existing, moved, { liveReservations: 0, liveOrders: 0 }, now)).toBeNull();
  });
});

function windowState(overrides: Partial<ExistingWindowState> = {}): ExistingWindowState {
  return {
    startsAt: new Date("2026-11-04T09:00:00.000Z"),
    endsAt: new Date("2026-11-04T11:00:00.000Z"),
    lastReservationAt: new Date("2026-11-04T08:30:00.000Z"),
    capacityUnits: 20,
    reservedUnits: 5,
    active: true,
    ...overrides,
  };
}

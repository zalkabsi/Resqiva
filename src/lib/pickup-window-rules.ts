import { z } from "zod";

const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

const dateTimeSchema = z.string().regex(DATE_TIME_WITH_OFFSET, "Use an ISO date-time with an explicit timezone, such as 2026-11-05T14:00:00+03:00.");

export const createPickupWindowSchema = z.object({
  storeId: z.string().min(1).max(128),
  startsAt: dateTimeSchema,
  endsAt: dateTimeSchema,
  lastReservationAt: dateTimeSchema,
  capacityUnits: z.number().int().min(1).max(10_000),
}).strict();

export const updatePickupWindowSchema = z.object({
  startsAt: dateTimeSchema.optional(),
  endsAt: dateTimeSchema.optional(),
  lastReservationAt: dateTimeSchema.optional(),
  capacityUnits: z.number().int().min(1).max(10_000).optional(),
  active: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0, "Provide at least one pickup-window field to update.");

export type CreatePickupWindowInput = z.infer<typeof createPickupWindowSchema>;
export type UpdatePickupWindowInput = z.infer<typeof updatePickupWindowSchema>;

export interface PickupWindowSchedule {
  startsAt: Date;
  endsAt: Date;
  lastReservationAt: Date;
}

export interface ExistingWindowState extends PickupWindowSchedule {
  active: boolean;
  capacityUnits: number;
  reservedUnits: number;
}

export interface PickupWindowUsage {
  liveReservations: number;
  liveOrders: number;
}

export interface PickupWindowCandidate extends PickupWindowSchedule {
  id?: string;
}

export function parseWindowDate(value: string): Date | null {
  if (!DATE_TIME_WITH_OFFSET.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function validateWindowSchedule(schedule: PickupWindowSchedule, now = new Date()): string | null {
  const orderError = validateWindowOrder(schedule);
  if (orderError) return orderError;
  const { startsAt, lastReservationAt } = schedule;
  if (startsAt.getTime() <= now.getTime()) return "Pickup must start in the future.";
  if (lastReservationAt.getTime() <= now.getTime()) return "The reservation cutoff must be in the future.";
  return null;
}

export function validateWindowOrder(schedule: PickupWindowSchedule): string | null {
  const { startsAt, endsAt, lastReservationAt } = schedule;
  if ([startsAt, endsAt, lastReservationAt].some((date) => !Number.isFinite(date.getTime()))) {
    return "Pickup times must be valid date-times.";
  }
  if (endsAt.getTime() <= startsAt.getTime()) return "Pickup must end after it starts.";
  if (lastReservationAt.getTime() > startsAt.getTime()) return "The reservation cutoff cannot be later than the pickup start.";
  return null;
}

export function windowsOverlap(left: PickupWindowSchedule, right: PickupWindowCandidate): boolean {
  return left.startsAt.getTime() < right.endsAt.getTime()
    && left.endsAt.getTime() > right.startsAt.getTime();
}

export function findOverlap(
  candidate: PickupWindowSchedule,
  existing: PickupWindowCandidate[],
  ignoreId?: string,
): PickupWindowCandidate | undefined {
  return existing.find((window) => window.id !== ignoreId && windowsOverlap(candidate, window));
}

export function scheduleChanged(existing: ExistingWindowState, next: PickupWindowSchedule): boolean {
  return existing.startsAt.getTime() !== next.startsAt.getTime()
    || existing.endsAt.getTime() !== next.endsAt.getTime()
    || existing.lastReservationAt.getTime() !== next.lastReservationAt.getTime();
}

export function validateWindowUpdate(
  existing: ExistingWindowState,
  next: ExistingWindowState,
  usage: PickupWindowUsage,
  now = new Date(),
): string | null {
  if (next.capacityUnits < existing.reservedUnits) {
    return "Capacity cannot be lower than units already reserved for this pickup window.";
  }

  const hasLiveWork = usage.liveReservations > 0 || usage.liveOrders > 0;
  if (scheduleChanged(existing, next) && hasLiveWork) {
    return "Pickup times cannot change while active reservations or orders use this window.";
  }
  if (existing.active && !next.active && hasLiveWork) {
    return "A pickup window with active reservations or orders cannot be deactivated.";
  }
  if (scheduleChanged(existing, next)) {
    const orderError = validateWindowOrder(next);
    if (orderError) return orderError;
  }
  if (next.active && (scheduleChanged(existing, next) || !existing.active)) {
    const scheduleError = validateWindowSchedule(next, now);
    if (scheduleError) return scheduleError;
  }
  return null;
}

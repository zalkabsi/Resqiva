import { z } from "zod";

function timezoneSchema() {
  return z.string().trim().min(1).max(80).superRefine((value, context) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
    } catch {
      context.addIssue({ code: "custom", message: "Use a valid IANA timezone." });
    }
  });
}

const editableFields = {
  name: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(80),
  timezone: timezoneSchema(),
  pickupAddress: z.string().trim().min(5).max(240),
};

export const createMerchantStoreSchema = z.object(editableFields).strict();

export const updateMerchantStoreSchema = z.object({
  name: editableFields.name.optional(),
  city: editableFields.city.optional(),
  timezone: editableFields.timezone.optional(),
  pickupAddress: editableFields.pickupAddress.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one store field to update.");

export type MerchantStoreInput = z.infer<typeof createMerchantStoreSchema>;
export type MerchantStorePatch = z.infer<typeof updateMerchantStoreSchema>;

export type ExistingStoreFields = MerchantStoreInput;

export interface StoreChangeUsage {
  liveReservations: number;
  liveOrders: number;
}

export function validateStoreChangeImpact(
  existing: ExistingStoreFields,
  next: ExistingStoreFields,
  usage: StoreChangeUsage,
): string | null {
  const pickupDetailsChanged = existing.timezone !== next.timezone
    || existing.pickupAddress !== next.pickupAddress;
  if (pickupDetailsChanged && (usage.liveReservations > 0 || usage.liveOrders > 0)) {
    return "Pickup address or timezone cannot change while live reservations or orders use this store.";
  }
  return null;
}

export function buildStoreSlug(name: string, city: string, suffix: string): string {
  const base = `${name}-${city}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const safeBase = base || "demo-store";
  const safeSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (safeSuffix.length < 8) throw new Error("Store slug suffix must contain at least eight alphanumeric characters.");
  return `${safeBase}-${safeSuffix}`;
}

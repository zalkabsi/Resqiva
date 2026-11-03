import { describe, expect, it } from "vitest";
import {
  buildStoreSlug,
  createMerchantStoreSchema,
  updateMerchantStoreSchema,
  validateStoreChangeImpact,
  type MerchantStoreInput,
} from "@/lib/merchant-store-rules";

const store: MerchantStoreInput = {
  name: "Neighborhood Market",
  city: "Riyadh",
  timezone: "Asia/Riyadh",
  pickupAddress: "Demo Block 7, Riyadh",
};

describe("merchant store input rules", () => {
  it("accepts store fields with a valid IANA timezone", () => {
    expect(createMerchantStoreSchema.safeParse(store).success).toBe(true);
  });

  it("rejects client-controlled IDs, currency, slug, and demo ownership", () => {
    expect(createMerchantStoreSchema.safeParse({ ...store, merchantId: "other-merchant" }).success).toBe(false);
    expect(createMerchantStoreSchema.safeParse({ ...store, currency: "EUR" }).success).toBe(false);
    expect(createMerchantStoreSchema.safeParse({ ...store, slug: "attacker-slug" }).success).toBe(false);
    expect(createMerchantStoreSchema.safeParse({ ...store, isDemo: false }).success).toBe(false);
  });

  it("rejects invalid IANA timezones and empty edits", () => {
    expect(createMerchantStoreSchema.safeParse({ ...store, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(updateMerchantStoreSchema.safeParse({}).success).toBe(false);
  });

  it("only permits the four editable store fields in updates", () => {
    expect(updateMerchantStoreSchema.safeParse({ name: "Updated Market" }).success).toBe(true);
    expect(updateMerchantStoreSchema.safeParse({ name: "Updated Market", currency: "EUR" }).success).toBe(false);
  });

  it("creates a server-side URL-safe slug and handles non-Latin names", () => {
    expect(buildStoreSlug("Fresh & Fine Market", "Riyadh", "123e4567-e89b-12d3-a456-426614174000"))
      .toBe("fresh-fine-market-riyadh-123e4567e89b");
    expect(buildStoreSlug("متجر", "الرياض", "123e4567-e89b-12d3-a456-426614174000"))
      .toBe("demo-store-123e4567e89b");
  });
});

describe("live store reservation protections", () => {
  it("allows descriptive name/city edits while restricting address/timezone edits with live orders", () => {
    expect(validateStoreChangeImpact(store, { ...store, name: "New Market" }, { liveReservations: 1, liveOrders: 1 })).toBeNull();
    expect(validateStoreChangeImpact(store, { ...store, city: "Jeddah" }, { liveReservations: 1, liveOrders: 0 })).toBeNull();
    expect(validateStoreChangeImpact(store, { ...store, pickupAddress: "New Demo Address" }, { liveReservations: 0, liveOrders: 1 })).toContain("cannot change");
    expect(validateStoreChangeImpact(store, { ...store, timezone: "UTC" }, { liveReservations: 1, liveOrders: 0 })).toContain("cannot change");
  });

  it("allows pickup details to change when no live reservation or order can be invalidated", () => {
    expect(validateStoreChangeImpact(store, { ...store, pickupAddress: "Updated Demo Address" }, { liveReservations: 0, liveOrders: 0 })).toBeNull();
  });
});

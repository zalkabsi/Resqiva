import { describe, expect, it } from "vitest";
import type { InventoryProduct, PlannerPreferences } from "../src/lib/contracts";
import {
  compareWithGreedyBaseline,
  greedyDiscountBaseline,
  optimizeBundles,
} from "../src/lib/optimizer";

const NOW = new Date("2026-11-03T12:00:00.000Z");

function product(
  id: string,
  category: string,
  name: string,
  priceCents: number,
  originalPriceCents: number,
  overrides: Partial<InventoryProduct> = {},
): InventoryProduct {
  return {
    id,
    storeId: "store-a",
    name,
    category,
    priceCents,
    originalPriceCents,
    quantityAvailable: 4,
    allergens: ["none declared"],
    dietaryTags: ["VEGETARIAN", "VEGAN", "GLUTEN_FREE", "DAIRY_FREE", "HALAL", "LOW_SODIUM"],
    ingredients: [name],
    expiresAt: "2026-11-10",
    pickupStart: "16:00",
    pickupEnd: "19:00",
    ...overrides,
  };
}

function inventory(overrides: Partial<InventoryProduct>[] = []): InventoryProduct[] {
  const base = [
    product("produce-1", "produce", "Tomatoes", 101, 201),
    product("protein-1", "protein", "Lentils", 120, 200),
    product("grain-1", "grain", "Brown rice", 99, 150),
  ];
  return base.map((item, index) => ({ ...item, ...overrides[index] }));
}

function request(overrides: Partial<PlannerPreferences> = {}): PlannerPreferences {
  return {
    budgetCents: 320,
    servings: 2,
    mealCount: 1,
    exclusions: [],
    allergies: [],
    preferredIngredients: [],
    avoidIngredients: [],
    pickupDate: "2026-11-03",
    sourceText: "",
    ...overrides,
  };
}

describe("inventory-grounded meal optimizer", () => {
  it("builds feasible bundles using real products and exact integer-cent totals", () => {
    const result = optimizeBundles(request(), inventory(), {
      now: NOW,
      storeNames: { "store-a": "Fictional Market" },
      maxBundles: 1,
    });

    expect(result.feasible).toBe(true);
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]).toMatchObject({
      storeId: "store-a",
      storeName: "Fictional Market",
      totalCents: 320,
      originalTotalCents: 551,
      savingsCents: 231,
      verifiedSurplusUnits: 3,
    });
    expect(result.bundles[0].items.map((item) => item.inventoryId).sort()).toEqual([
      "grain-1",
      "produce-1",
      "protein-1",
    ]);
    expect(result.metrics.constraintViolations).toBe(0);
    expect(result.metrics.feasibilityRate).toBeGreaterThan(0);
  });

  it("accepts an exact budget boundary and rejects one cent below it", () => {
    expect(optimizeBundles(request({ budgetCents: 320 }), inventory(), { now: NOW }).feasible).toBe(true);
    const tooLow = optimizeBundles(request({ budgetCents: 319 }), inventory(), { now: NOW });
    expect(tooLow.feasible).toBe(false);
    expect(tooLow.blockers).toContain("BUDGET");
  });

  it("scales package quantities to servings and respects cumulative stock", () => {
    const scaled = optimizeBundles(
      request({ servings: 3, budgetCents: 1_000 }),
      inventory(),
      { now: NOW, maxBundles: 1 },
    );
    expect(scaled.feasible).toBe(true);
    expect(scaled.bundles[0].items.every((item) => item.quantity === 2)).toBe(true);

    const products = inventory([
      { quantityAvailable: 1 },
      { quantityAvailable: 1 },
      { quantityAvailable: 1 },
    ]);
    const tooManyServings = optimizeBundles(request({ servings: 3 }), products, { now: NOW });
    expect(tooManyServings.feasible).toBe(false);
    expect(tooManyServings.blockers).toContain("NO_RECIPE_MATCH");

    const twoMealsShort = optimizeBundles(request({ mealCount: 2, budgetCents: 1_000 }), products, { now: NOW });
    expect(twoMealsShort.feasible).toBe(false);
    expect(twoMealsShort.blockers).toContain("STOCK");
  });

  it("keeps every bundle within one requested store", () => {
    const products = inventory([
      { storeId: "store-a" },
      { storeId: "store-b" },
      { storeId: "store-a" },
    ]);
    const result = optimizeBundles(request(), products, { now: NOW });
    expect(result.feasible).toBe(false);

    const filtered = optimizeBundles(request({ storeId: "store-b" }), products, { now: NOW });
    expect(filtered.feasible).toBe(false);
    expect(filtered.blockers).toContain("NO_RECIPE_MATCH");
  });

  it("requires a common pickup window for all selected items", () => {
    const products = inventory([
      {},
      { pickupStart: "19:00", pickupEnd: "20:00" },
      {},
    ]);
    const result = optimizeBundles(request(), products, { now: NOW });
    expect(result.feasible).toBe(false);
    expect(result.blockers).toContain("PICKUP_WINDOW");
  });

  it("rejects inventory that expires before the requested pickup date", () => {
    const products = inventory([{ expiresAt: "2026-11-02" }, {}, {}]);
    const result = optimizeBundles(request(), products, { now: NOW });
    expect(result.feasible).toBe(false);
    expect(result.blockers).toContain("EXPIRED");
  });

  it("does not treat missing allergen metadata as a clean allergen result", () => {
    const products = inventory([{ allergens: [] }, {}, {}]);
    const result = optimizeBundles(request({ allergies: ["peanuts"] }), products, { now: NOW });
    expect(result.feasible).toBe(false);
    expect(result.blockers).toContain("UNKNOWN_ALLERGEN_DATA");
  });

  it("rejects explicit allergen matches and keeps a safety caveat in results", () => {
    const withPeanut = inventory([{ allergens: ["peanut"] }, {}, {}]);
    const blocked = optimizeBundles(request({ allergies: ["groundnuts"] }), withPeanut, { now: NOW });
    expect(blocked.feasible).toBe(false);
    expect(blocked.blockers).toContain("ALLERGEN_MISMATCH");

    const disclosed = optimizeBundles(request({ allergies: ["peanuts"] }), inventory(), {
      now: NOW,
      maxBundles: 1,
    });
    expect(disclosed.feasible).toBe(true);
    expect(disclosed.bundles[0].explanation).toContain("not guaranteed");

    const contradictoryLabels = inventory([
      { allergens: ["none declared"], ingredients: ["tomato", "peanuts"] },
      {},
      {},
    ]);
    const rejected = optimizeBundles(request({ allergies: ["peanut"] }), contradictoryLabels, { now: NOW });
    expect(rejected.feasible).toBe(false);
    expect(rejected.blockers).toContain("ALLERGEN_MISMATCH");
  });

  it("enforces dietary tags and ingredient exclusions as hard constraints", () => {
    const missingTag = inventory([{ dietaryTags: ["VEGETARIAN"] }, {}, {}]);
    const vegan = optimizeBundles(request({ exclusions: ["vegan"] }), missingTag, { now: NOW });
    expect(vegan.feasible).toBe(false);
    expect(vegan.blockers).toContain("DIETARY_RESTRICTION");

    const excluded = inventory([{ ingredients: ["tomato", "peanut oil"] }, {}, {}]);
    const noPeanut = optimizeBundles(request({ avoidIngredients: ["peanut"] }), excluded, { now: NOW });
    expect(noPeanut.feasible).toBe(false);
    expect(noPeanut.blockers).toContain("DIETARY_RESTRICTION");
  });

  it("rejects malformed monetary or serving inputs", () => {
    const invalidMoney = optimizeBundles(request({ budgetCents: 1.25 }), inventory(), { now: NOW });
    expect(invalidMoney.feasible).toBe(false);
    expect(invalidMoney.blockers).toContain("INVALID_REQUEST");
  });

  it("provides a comparable greedy discount-ranking baseline", () => {
    const products = inventory();
    const preferences = request();
    const baseline = greedyDiscountBaseline(preferences, products, { now: NOW });
    expect(baseline.feasible).toBe(true);
    expect(baseline.totalCents).toBe(320);
    expect(baseline.selectedInventoryIds).toHaveLength(3);

    const result = optimizeBundles(preferences, products, { now: NOW, maxBundles: 1 });
    expect(compareWithGreedyBaseline(result, preferences, products, { now: NOW })).toMatchObject({
      optimizer: { feasible: true, totalCents: 320, savingsCents: 231 },
      greedyDiscountBaseline: { feasible: true, totalCents: 320 },
    });
  });
});

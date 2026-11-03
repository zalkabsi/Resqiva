import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { compareWithGreedyBaseline, optimizeBundles } from "../src/lib/optimizer";
import type { InventoryProduct, PlannerPreferences } from "../src/lib/contracts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required to benchmark the seeded demo inventory.");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
const REPEATS = 25;
const now = new Date();

function localDate(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function milliseconds(values: number[]) {
  return {
    median: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
  };
}

function countConstraintViolations(
  result: ReturnType<typeof optimizeBundles>,
  preferences: PlannerPreferences,
  inventory: InventoryProduct[],
): { count: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  const record = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  for (const bundle of result.bundles) {
    const selected = new Map<string, number>();
    let totalCents = 0;
    let originalCents = 0;
    const pickupEnd = new Date(bundle.pickupEnd);
    if (bundle.totalCents > preferences.budgetCents) record("budget");
    if (bundle.meals.length !== preferences.mealCount) record("meal-count");
    if (bundle.meals.some((meal) => meal.servings < preferences.servings)) record("servings");
    if (bundle.storeId !== preferences.storeId) record("store");
    for (const item of bundle.items) {
      const product = inventory.find((candidate) => candidate.id === item.inventoryId);
      if (!product) {
        record("missing-inventory-id");
        continue;
      }
      selected.set(product.id, (selected.get(product.id) ?? 0) + item.quantity);
      totalCents += item.quantity * item.unitPriceCents;
      originalCents += item.quantity * item.originalUnitPriceCents;
      if (product.storeId !== bundle.storeId) record("item-store");
      if (product.priceCents !== item.unitPriceCents) record("item-price");
      if (item.quantity < 1) record("item-quantity");
      if (!product.expiresAt || new Date(product.expiresAt) < pickupEnd) record("expiry");
      if (preferences.allergies.length > 0) {
        const allergenText = product.allergens.join(" ").toLowerCase();
        if (!product.allergens.length || product.allergens.some((allergen) => allergen.toLowerCase() === "unknown")) record("unknown-allergen-data");
        if (preferences.allergies.some((allergen) => allergenText.includes(allergen.toLowerCase()))) record("allergen-match");
      }
      const tags = product.dietaryTags.map((tag) => tag.toLowerCase());
      if (preferences.exclusions.some((term) => ["vegetarian", "vegan", "gluten_free", "dairy_free"].includes(term.toLowerCase()) && !tags.includes(term.toLowerCase()))) record("dietary-tag");
    }
    if ([...selected].some(([id, quantity]) => quantity > (inventory.find((product) => product.id === id)?.quantityAvailable ?? 0))) record("stock");
    if (totalCents !== bundle.totalCents) record("total");
    if (originalCents !== bundle.originalTotalCents) record("original-total");
    if (originalCents - totalCents !== bundle.savingsCents) record("savings");
  }
  return { count: Object.values(reasons).reduce((sum, count) => sum + count, 0), reasons };
}

async function main() {
  const stores = await prisma.store.findMany({
    where: { isDemo: true },
    include: {
      pickupWindows: { where: { active: true, startsAt: { gt: now }, endsAt: { gt: now } }, orderBy: { startsAt: "asc" } },
      inventoryLots: { where: { sellable: true }, include: { product: true } },
    },
    orderBy: { name: "asc" },
  });

  const scenarios: Array<{ name: string; storeName: string; preferences: PlannerPreferences; inventory: InventoryProduct[] }> = [];
  for (const store of stores) {
    const pickup = store.pickupWindows[0];
    if (!pickup) continue;
    const inventory: InventoryProduct[] = store.inventoryLots.flatMap((lot) => {
      const available = lot.quantityOnHand - lot.quantityReserved - lot.quantitySold;
      if (!lot.product.isActive || available < 1 || !lot.expiresAt || lot.expiresAt < pickup.endsAt) return [];
      if (!Number.isSafeInteger(lot.discountedPriceCents) || !Number.isSafeInteger(lot.originalPriceCents) || lot.originalPriceCents < lot.discountedPriceCents) return [];
      const allergens = lot.product.allergenDataStatus === "VERIFIED"
        ? (lot.product.knownAllergens.length ? [...lot.product.knownAllergens] : ["none"])
        : [...lot.product.knownAllergens, "unknown"];
      return [{
        id: lot.id,
        storeId: store.id,
        name: lot.product.name,
        category: lot.product.category,
        priceCents: lot.discountedPriceCents,
        originalPriceCents: lot.originalPriceCents,
        quantityAvailable: available,
        allergens,
        dietaryTags: lot.product.dietaryTags,
        ingredients: lot.product.ingredients,
        expiresAt: lot.expiresAt.toISOString(),
        pickupStart: pickup.startsAt.toISOString(),
        pickupEnd: pickup.endsAt.toISOString(),
      }];
    });
    const requests = [
      { name: "one vegetarian dinner", budgetCents: 2_500, servings: 2, mealCount: 1, exclusions: ["vegetarian"], allergies: [] },
      { name: "one vegan dinner", budgetCents: 3_000, servings: 2, mealCount: 1, exclusions: ["vegan"], allergies: [] },
      { name: "two vegetarian dinners with peanut exclusion", budgetCents: 6_000, servings: 3, mealCount: 2, exclusions: ["vegetarian"], allergies: ["peanut"] },
      { name: "one unrestricted dinner", budgetCents: 4_000, servings: 3, mealCount: 1, exclusions: [], allergies: [] },
    ];
    for (const request of requests) {
      scenarios.push({
        name: request.name,
        storeName: store.name,
        inventory,
        preferences: {
          budgetCents: request.budgetCents,
          servings: request.servings,
          mealCount: request.mealCount,
          exclusions: request.exclusions,
          allergies: request.allergies,
          preferredIngredients: [],
          avoidIngredients: [],
          pickupDate: localDate(pickup.startsAt, store.timezone),
          storeId: store.id,
          sourceText: request.name,
        },
      });
    }
  }
  if (!scenarios.length) throw new Error("No seeded store has a future pickup window to benchmark.");

  const optimizerTimes: number[] = [];
  const baselineTimes: number[] = [];
  const scenarioResults: Array<Record<string, unknown>> = [];
  let optimizerFeasible = 0;
  let baselineFeasible = 0;
  let violationCount = 0;
  let optimizerLowerTotal = 0;
  let optimizerHigherTotal = 0;
  let optimizerEqualTotal = 0;
  let measuredRuns = 0;

  for (const scenario of scenarios) {
    let result!: ReturnType<typeof optimizeBundles>;
    let comparison!: ReturnType<typeof compareWithGreedyBaseline>;
    const scenarioOptimizerTimes: number[] = [];
    const scenarioBaselineTimes: number[] = [];
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const startOptimizer = performance.now();
      result = optimizeBundles(scenario.preferences, scenario.inventory, { now });
      scenarioOptimizerTimes.push(performance.now() - startOptimizer);

      const startBaseline = performance.now();
      comparison = compareWithGreedyBaseline(result, scenario.preferences, scenario.inventory, { now });
      scenarioBaselineTimes.push(performance.now() - startBaseline);
    }
    optimizerTimes.push(...scenarioOptimizerTimes);
    baselineTimes.push(...scenarioBaselineTimes);
    measuredRuns += 1;
    if (result.feasible) optimizerFeasible += 1;
    if (comparison.greedyDiscountBaseline.feasible) baselineFeasible += 1;
    const violations = countConstraintViolations(result, scenario.preferences, scenario.inventory);
    violationCount += violations.count;
    if (result.bundles[0] && comparison.greedyDiscountBaseline.feasible) {
      if (result.bundles[0].totalCents < comparison.greedyDiscountBaseline.totalCents) optimizerLowerTotal += 1;
      else if (result.bundles[0].totalCents > comparison.greedyDiscountBaseline.totalCents) optimizerHigherTotal += 1;
      else optimizerEqualTotal += 1;
    }
    scenarioResults.push({
      store: scenario.storeName,
      request: scenario.name,
      inventoryRecords: scenario.inventory.length,
      optimizerFeasible: result.feasible,
      optimizerBundlesReturned: result.bundles.length,
      optimizerFeasiblePlans: result.metrics.feasiblePlans,
      optimizerSearchNodes: result.metrics.searchNodes,
      optimizerConstraintViolations: result.metrics.constraintViolations,
      independentlyCheckedConstraintViolations: violations.count,
      constraintViolationReasons: violations.reasons,
      optimizerBestTotalCents: result.bundles[0]?.totalCents ?? null,
      optimizerBestSavingsCents: result.bundles[0]?.savingsCents ?? null,
      greedyBaselineFeasible: comparison.greedyDiscountBaseline.feasible,
      greedyBaselineTotalCents: comparison.greedyDiscountBaseline.feasible ? comparison.greedyDiscountBaseline.totalCents : null,
      optimizerRuntimeMs: milliseconds(scenarioOptimizerTimes),
      greedyBaselineRuntimeMs: milliseconds(scenarioBaselineTimes),
    });
  }

  console.log(JSON.stringify({
    runAt: now.toISOString(),
    source: "seeded fictional PostgreSQL inventory",
    inventoryRecordsByStore: [...new Set(scenarios.map((scenario) => scenario.storeName))].map((storeName) => ({
      store: storeName,
      records: scenarios.find((scenario) => scenario.storeName === storeName)?.inventory.length ?? 0,
    })),
    requestScenarios: measuredRuns,
    repetitionsPerScenario: REPEATS,
    optimizerFeasibleScenarios: optimizerFeasible,
    greedyBaselineFeasibleScenarios: baselineFeasible,
    independentlyCheckedConstraintViolations: violationCount,
    optimizerLowerTotalScenarios: optimizerLowerTotal,
    optimizerHigherTotalScenarios: optimizerHigherTotal,
    optimizerEqualTotalScenarios: optimizerEqualTotal,
    optimizerRuntimeMs: milliseconds(optimizerTimes),
    greedyBaselineRuntimeMs: milliseconds(baselineTimes),
    results: scenarioResults,
    note: "Benchmark compares the bounded optimizer and greedy discount-ranking baseline under the same hard rules. One seeded demo run is not proof of general superiority or real-world impact.",
  }, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Optimizer benchmark failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import type {
  DietaryTag,
  InventoryProduct,
  PlannedBundle,
  PlannedItem,
  PlannedMeal,
  PlannerPreferences,
} from "./contracts";

type Role = "produce" | "protein" | "grain";

interface RecipeTemplate {
  id: string;
  title: string;
  roles: Role[];
  pantryStaples: string[];
  instructions: string[];
}

interface RecipeCandidate {
  template: RecipeTemplate;
  products: InventoryProduct[];
  quantities: number[];
  totalCents: number;
  originalCents: number;
  preferenceHits: number;
  preferenceCount: number;
  urgency: number;
  pickup: TimeWindow;
  canonical: string;
  score: number;
}

interface TimeWindow {
  kind: "clock" | "instant";
  start: number;
  end: number;
  dateKey?: string;
}

export type OptimizationBlocker =
  | "INVALID_REQUEST"
  | "NO_INVENTORY"
  | "NO_RECIPE_MATCH"
  | "BUDGET"
  | "STOCK"
  | "PICKUP_WINDOW"
  | "EXPIRED"
  | "DIETARY_RESTRICTION"
  | "ALLERGEN_MISMATCH"
  | "UNKNOWN_ALLERGEN_DATA";

export interface OptimizerMetrics {
  inventoryRecords: number;
  storesConsidered: number;
  recipeCandidates: number;
  searchNodes: number;
  terminalPlanAttempts: number;
  feasiblePlans: number;
  constraintViolations: number;
  feasibilityRate: number;
  searchTruncated: boolean;
  elapsedMs: number;
}

export interface OptimizerOptions {
  storeNames?: Record<string, string>;
  maxBundles?: number;
  maxSearchNodes?: number;
  now?: Date;
}

export interface OptimizationResult {
  feasible: boolean;
  bundles: PlannedBundle[];
  blockers: OptimizationBlocker[];
  metrics: OptimizerMetrics;
}

export interface GreedyBaselineResult {
  feasible: boolean;
  storeId?: string;
  selectedInventoryIds: string[];
  totalCents: number;
  mealCount: number;
  reason?: string;
}

export interface BenchmarkComparison {
  optimizer: { feasible: boolean; totalCents?: number; savingsCents?: number };
  greedyDiscountBaseline: GreedyBaselineResult;
}

const TEMPLATES: RecipeTemplate[] = [
  {
    id: "grain-bowl",
    title: "Market grain bowls",
    roles: ["grain", "produce", "protein"],
    pantryStaples: ["cooking oil", "salt", "black pepper"],
    instructions: [
      "Prepare the grain according to its package directions.",
      "Cook the protein thoroughly according to its package directions.",
      "Cook or roast the produce, then serve it over the grain with the protein.",
    ],
  },
  {
    id: "pasta-skillet",
    title: "Seasonal vegetable skillet",
    roles: ["grain", "produce", "protein"],
    pantryStaples: ["cooking oil", "salt", "black pepper"],
    instructions: [
      "Prepare the grain according to its package directions.",
      "Cook the protein thoroughly according to its package directions.",
      "Sauté the produce and combine it with the prepared grain and protein.",
    ],
  },
  {
    id: "stuffed-market-plate",
    title: "Stuffed market vegetables",
    roles: ["produce", "grain", "protein"],
    pantryStaples: ["cooking oil", "salt", "black pepper"],
    instructions: [
      "Prepare the grain and protein according to their package directions.",
      "Cook the produce until tender; combine with the grain and protein.",
      "Season with pantry staples to taste.",
    ],
  },
  {
    id: "one-pan-supper",
    title: "One-pan produce and protein supper",
    roles: ["produce", "protein", "grain"],
    pantryStaples: ["cooking oil", "salt", "black pepper"],
    instructions: [
      "Cook the grain according to its package directions.",
      "Cook the protein thoroughly according to its package directions.",
      "Cook the produce until tender and serve with the grain and protein.",
    ],
  },
];

const ROLE_WORDS: Record<Role, string[]> = {
  produce: [
    "produce",
    "vegetable",
    "vegetables",
    "fruit",
    "tomato",
    "onion",
    "pepper",
    "spinach",
    "carrot",
    "broccoli",
    "zucchini",
    "mushroom",
    "squash",
    "cabbage",
    "lettuce",
  ],
  protein: [
    "protein",
    "proteins",
    "bean",
    "beans",
    "lentil",
    "lentils",
    "chickpea",
    "chickpeas",
    "tofu",
    "chicken",
    "beef",
    "turkey",
    "pork",
    "fish",
    "salmon",
    "tuna",
    "seafood",
    "egg",
    "eggs",
  ],
  grain: [
    "grain",
    "grains",
    "rice",
    "pasta",
    "noodle",
    "noodles",
    "bread",
    "oat",
    "oats",
    "barley",
    "quinoa",
    "couscous",
    "tortilla",
    "wrap",
    "flour",
  ],
};

const ALLERGEN_ALIASES: Record<string, string[]> = {
  peanut: ["peanut", "groundnut"],
  tree_nut: ["almond", "brazil nut", "cashew", "hazelnut", "macadamia", "pecan", "pistachio", "walnut", "tree nut", "nuts"],
  milk: ["milk", "dairy", "casein", "whey", "lactose"],
  egg: ["egg", "albumin"],
  wheat: ["wheat", "gluten"],
  soy: ["soy", "soya"],
  fish: ["fish", "anchovy"],
  shellfish: ["shellfish", "shrimp", "prawn", "crab", "lobster", "crayfish"],
  sesame: ["sesame", "tahini"],
};

const UNKNOWN_ALLERGEN_MARKERS = new Set(["unknown", "unspecified", "not provided"]);
const MAX_ALTERNATIVES_PER_ROLE = 8;
const MAX_RECIPE_CANDIDATES_PER_STORE = 500;
const DEFAULT_MAX_SEARCH_NODES = 40_000;

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeToken(value: string): string {
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function wordsForProduct(product: InventoryProduct): string {
  return normalize(
    [product.name, product.category, ...product.ingredients, ...product.dietaryTags]
      .filter(Boolean)
      .join(" "),
  );
}

function containsTerm(haystack: string, term: string): boolean {
  const needle = normalize(term).split(" ").filter(Boolean).map(normalizeToken);
  const words = normalize(haystack).split(" ").filter(Boolean).map(normalizeToken);
  if (needle.length === 0 || needle.length > words.length) return false;
  return words.some((_, start) => needle.every((word, offset) => words[start + offset] === word));
}

function aliasSet(term: string): string[] {
  const normalized = normalize(term);
  const singular = normalized.endsWith("s") ? normalized.slice(0, -1) : normalized;
  for (const [key, aliases] of Object.entries(ALLERGEN_ALIASES)) {
    if (aliases.some((alias) => normalize(alias) === normalized || normalize(alias) === singular)) {
      return [key, ...aliases].map(normalize);
    }
  }
  return [normalized, singular].filter(Boolean);
}

function allergenDataKnown(product: InventoryProduct): boolean {
  if (product.allergens.length === 0) return false;
  return !product.allergens.some((allergen) => UNKNOWN_ALLERGEN_MARKERS.has(normalize(allergen)));
}

function productHasRequestedAllergen(product: InventoryProduct, requested: string): boolean {
  const aliases = aliasSet(requested);
  const declared = product.allergens.map(normalize);
  if (declared.some((value) => aliases.some((alias) => containsTerm(value, alias)))) return true;
  // Ingredient labels are an additional rejection signal, never proof that an
  // item is free from cross-contact or undeclared allergens.
  const ingredientText = normalize(product.ingredients.join(" "));
  return aliases.some((alias) => containsTerm(ingredientText, alias));
}

function dietaryTagFor(term: string): DietaryTag | undefined {
  const value = normalize(term).replace(/ /g, "_");
  const aliases: Record<string, DietaryTag> = {
    vegetarian: "VEGETARIAN",
    vegan: "VEGAN",
    "gluten_free": "GLUTEN_FREE",
    "dairy_free": "DAIRY_FREE",
    "halal": "HALAL",
    "low_sodium": "LOW_SODIUM",
  };
  return aliases[value];
}

function requiredDietaryTags(preferences: PlannerPreferences): DietaryTag[] {
  const values = [...preferences.exclusions, ...preferences.avoidIngredients];
  const tags = values.map(dietaryTagFor).filter((value): value is DietaryTag => Boolean(value));
  return [...new Set(tags)];
}

function productMeetsRestrictions(
  product: InventoryProduct,
  preferences: PlannerPreferences,
  counters: Record<OptimizationBlocker, number>,
): boolean {
  const text = wordsForProduct(product);
  const requestedAllergens = [...preferences.allergies];
  const requestedTerms = [
    ...preferences.exclusions.filter((term) => !dietaryTagFor(term)),
    ...preferences.avoidIngredients,
  ];

  if (requestedAllergens.length > 0) {
    if (!allergenDataKnown(product)) {
      counters.UNKNOWN_ALLERGEN_DATA += 1;
      return false;
    }
    if (requestedAllergens.some((allergen) => productHasRequestedAllergen(product, allergen))) {
      counters.ALLERGEN_MISMATCH += 1;
      return false;
    }
  }

  if (requestedTerms.some((term) => containsTerm(text, term))) {
    counters.DIETARY_RESTRICTION += 1;
    return false;
  }

  const requiredTags = requiredDietaryTags(preferences);
  const productTags = new Set(product.dietaryTags.map((tag) => normalize(tag).replace(/ /g, "_")));
  if (requiredTags.some((tag) => !productTags.has(tag.toLocaleLowerCase("en")))) {
    counters.DIETARY_RESTRICTION += 1;
    return false;
  }
  return true;
}

function parseEndpoint(value: string): TimeWindow | undefined {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return undefined;
    return { kind: "clock", start: hours * 60 + minutes, end: hours * 60 + minutes };
  }
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(value.trim());
  if (dateOnly) {
    const day = Date.parse(`${dateOnly[1]}T00:00:00Z`);
    if (!Number.isFinite(day)) return undefined;
    return { kind: "instant", start: day, end: day, dateKey: dateOnly[1] };
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return { kind: "instant", start: parsed, end: parsed, dateKey: value.slice(0, 10) };
}

function parseWindow(startText: string, endText: string): TimeWindow | undefined {
  const start = parseEndpoint(startText);
  const end = parseEndpoint(endText);
  if (!start || !end || start.kind !== end.kind) return undefined;
  const normalizedEnd =
    start.kind === "clock" && end.start < start.start ? end.start + 24 * 60 : end.start;
  const window = {
    kind: start.kind,
    start: start.start,
    end: normalizedEnd,
    dateKey: start.dateKey,
  } as TimeWindow;
  return window.end > window.start ? window : undefined;
}

function intersectWindows(left: TimeWindow, right: TimeWindow): TimeWindow | undefined {
  if (left.kind !== right.kind) return undefined;
  if (left.dateKey && right.dateKey && left.dateKey !== right.dateKey) return undefined;
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);
  if (end <= start) return undefined;
  return {
    kind: left.kind,
    start,
    end,
    dateKey: left.dateKey ?? right.dateKey,
  };
}

function displayEndpoint(window: TimeWindow, value: number): string {
  if (window.kind === "instant") return new Date(value).toISOString();
  const normalized = value % (24 * 60);
  const hours = Math.floor(normalized / 60).toString().padStart(2, "0");
  const minutes = (normalized % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function normalizePickupDate(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match?.[1];
}

function isPastPickupDate(expiry: string | null, pickupDate: string): boolean {
  if (!expiry) return false;
  const pickupDay = normalizePickupDate(pickupDate);
  const expiryDay = normalizePickupDate(expiry);
  if (!pickupDay || !expiryDay) return false;
  return expiryDay < pickupDay;
}

function daysUntilExpiry(expiry: string | null, pickupDate: string, now: Date): number | undefined {
  if (!expiry) return undefined;
  const basis = normalizePickupDate(pickupDate) ?? now.toISOString().slice(0, 10);
  const expiryDay = normalizePickupDate(expiry);
  if (!expiryDay) return undefined;
  return Math.floor((Date.parse(`${expiryDay}T00:00:00Z`) - Date.parse(`${basis}T00:00:00Z`)) / 86_400_000);
}

function productMatchesRole(product: InventoryProduct, role: Role): boolean {
  const text = wordsForProduct(product);
  const category = normalize(product.category);
  return ROLE_WORDS[role].some((word) => containsTerm(`${category} ${text}`, word));
}

function validInventory(product: InventoryProduct): boolean {
  return (
    Number.isInteger(product.priceCents) &&
    product.priceCents >= 0 &&
    Number.isInteger(product.originalPriceCents) &&
    product.originalPriceCents >= product.priceCents &&
    Number.isInteger(product.quantityAvailable) &&
    product.quantityAvailable >= 0
  );
}

function quantityForServings(servings: number): number {
  // Demo recipe templates use one package for each role per two servings.
  return Math.max(1, Math.ceil(servings / 2));
}

function combinations<T>(
  buckets: T[][],
  limit: number,
  callback: (items: T[]) => void,
): void {
  const selected: T[] = [];
  let emitted = 0;
  const visit = (index: number) => {
    if (emitted >= limit) return;
    if (index === buckets.length) {
      emitted += 1;
      callback([...selected]);
      return;
    }
    for (const item of buckets[index]) {
      selected.push(item);
      visit(index + 1);
      selected.pop();
      if (emitted >= limit) break;
    }
  };
  visit(0);
}

function makeRecipeCandidates(
  products: InventoryProduct[],
  preferences: PlannerPreferences,
  now: Date,
  counters: Record<OptimizationBlocker, number>,
): RecipeCandidate[] {
  const eligible = products.filter((product) => {
    if (!validInventory(product) || product.quantityAvailable < 1) return false;
    if (isPastPickupDate(product.expiresAt, preferences.pickupDate)) {
      counters.EXPIRED += 1;
      return false;
    }
    if (!productMeetsRestrictions(product, preferences, counters)) return false;
    return true;
  });

  const quantity = quantityForServings(preferences.servings);
  const result: RecipeCandidate[] = [];
  for (const template of TEMPLATES) {
    const buckets = template.roles.map((role) =>
      eligible
        .filter((product) => productMatchesRole(product, role) && product.quantityAvailable >= quantity)
        .sort((a, b) => {
          const aDiscount = a.originalPriceCents - a.priceCents;
          const bDiscount = b.originalPriceCents - b.priceCents;
          return bDiscount - aDiscount || a.id.localeCompare(b.id);
        })
        .slice(0, MAX_ALTERNATIVES_PER_ROLE),
    );
    if (buckets.some((bucket) => bucket.length === 0)) continue;

    combinations(buckets, 2_000, (selected) => {
      const uniqueIds = new Set(selected.map((product) => product.id));
      if (uniqueIds.size !== selected.length) return;
      const windows = selected.map((product) => parseWindow(product.pickupStart, product.pickupEnd));
      if (windows.some((window) => !window)) {
        counters.PICKUP_WINDOW += 1;
        return;
      }
      let pickup = windows[0] as TimeWindow;
      for (const window of windows.slice(1) as TimeWindow[]) {
        const intersection = intersectWindows(pickup, window);
        if (!intersection) {
          pickup = undefined as unknown as TimeWindow;
          break;
        }
        pickup = intersection;
      }
      if (!pickup) {
        counters.PICKUP_WINDOW += 1;
        return;
      }
      const requestedDay = normalizePickupDate(preferences.pickupDate);
      if (requestedDay && pickup.dateKey && requestedDay !== pickup.dateKey) {
        counters.PICKUP_WINDOW += 1;
        return;
      }

      const preferenceTerms = preferences.preferredIngredients.map(normalize).filter(Boolean);
      const preferenceHits = preferenceTerms.filter((term) =>
        selected.some((product) => containsTerm(wordsForProduct(product), term)),
      ).length;
      const totalCents = selected.reduce((sum, product) => sum + product.priceCents * quantity, 0);
      const originalCents = selected.reduce(
        (sum, product) => sum + product.originalPriceCents * quantity,
        0,
      );
      const urgencyValues = selected
        .map((product) => daysUntilExpiry(product.expiresAt, preferences.pickupDate, now))
        .filter((days): days is number => days !== undefined && days >= 0)
        .map((days) => Math.max(0, 1 - days / 7));
      const urgency = urgencyValues.length
        ? urgencyValues.reduce((sum, value) => sum + value, 0) / urgencyValues.length
        : 0;
      const preferenceCount = Math.max(1, preferenceTerms.length);
      const canonical = `${template.id}:${selected.map((product) => product.id).sort().join(",")}`;
      const discountScore = originalCents > 0 ? (originalCents - totalCents) / originalCents : 0;
      const preferenceScore = preferenceHits / preferenceCount;
      const budgetValueScore = Math.max(0, 1 - totalCents / Math.max(1, preferences.budgetCents));
      // Weighted objective: savings 35%, requested ingredients 30%, expiry
      // urgency 20%, and budget headroom 15%. Feasibility is handled first.
      const score =
        0.35 * discountScore +
        0.3 * preferenceScore +
        0.2 * urgency +
        0.15 * budgetValueScore;
      result.push({
        template,
        products: selected,
        quantities: selected.map(() => quantity),
        totalCents,
        originalCents,
        preferenceHits,
        preferenceCount,
        urgency,
        pickup,
        canonical,
        score,
      });
    });
  }
  return result;
}

function validatePreferences(preferences: PlannerPreferences): boolean {
  return (
    Number.isInteger(preferences.budgetCents) &&
    preferences.budgetCents >= 0 &&
    Number.isInteger(preferences.servings) &&
    preferences.servings >= 1 &&
    preferences.servings <= 20 &&
    Number.isInteger(preferences.mealCount) &&
    preferences.mealCount >= 1 &&
    preferences.mealCount <= 8 &&
    preferences.pickupDate.trim().length > 0
  );
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function aggregateSelection(candidates: RecipeCandidate[]): Map<string, number> {
  const aggregate = new Map<string, number>();
  for (const candidate of candidates) {
    candidate.products.forEach((product, index) => {
      aggregate.set(product.id, (aggregate.get(product.id) ?? 0) + candidate.quantities[index]);
    });
  }
  return aggregate;
}

function selectionPickup(candidates: RecipeCandidate[]): TimeWindow | undefined {
  if (candidates.length === 0) return undefined;
  let pickup = candidates[0].pickup;
  for (const candidate of candidates.slice(1)) {
    const intersection = intersectWindows(pickup, candidate.pickup);
    if (!intersection) return undefined;
    pickup = intersection;
  }
  return pickup;
}

function bundleFromSelection(
  storeId: string,
  storeProducts: InventoryProduct[],
  candidates: RecipeCandidate[],
  preferences: PlannerPreferences,
  storeNames?: Record<string, string>,
): PlannedBundle {
  const byId = new Map(storeProducts.map((product) => [product.id, product]));
  const aggregate = aggregateSelection(candidates);
  const items: PlannedItem[] = [...aggregate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, quantity]) => {
      const product = byId.get(id)!;
      return {
        inventoryId: product.id,
        productName: product.name,
        quantity,
        unitPriceCents: product.priceCents,
        originalUnitPriceCents: product.originalPriceCents,
      };
    });
  const totalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const originalTotalCents = items.reduce(
    (sum, item) => sum + item.originalUnitPriceCents * item.quantity,
    0,
  );
  const meals: PlannedMeal[] = candidates.map((candidate) => ({
    title: candidate.template.title,
    servings: preferences.servings,
    itemNames: candidate.products.map((product) => product.name),
    pantryStaples: candidate.template.pantryStaples,
    instructions: candidate.template.instructions,
  }));
  const pickup = selectionPickup(candidates)!;
  const safetyNote =
    preferences.allergies.length > 0
      ? " Listed allergen metadata was checked, but cross-contact and label completeness are not guaranteed; confirm package labels before eating."
      : "";
  return {
    id: `bundle_${stableHash(`${storeId}:${candidates.map((candidate) => candidate.canonical).join("|")}`)}`,
    storeId,
    storeName: storeNames?.[storeId] ?? `Demo store ${storeId}`,
    items,
    meals,
    totalCents,
    originalTotalCents,
    savingsCents: Math.max(0, originalTotalCents - totalCents),
    verifiedSurplusUnits: items.reduce((sum, item) => sum + item.quantity, 0),
    pickupStart: displayEndpoint(pickup, pickup.start),
    pickupEnd: displayEndpoint(pickup, pickup.end),
    explanation: `A feasible ${candidates.length}-meal bundle uses current inventory from one store. Recipe templates assume one package per ingredient role for every two servings; check package quantities and labels before preparation.${safetyNote}`,
  };
}

function compareSelections(left: RecipeCandidate[], right: RecipeCandidate[]): number {
  const leftScore = left.reduce((sum, candidate) => sum + candidate.score, 0) / left.length;
  const rightScore = right.reduce((sum, candidate) => sum + candidate.score, 0) / right.length;
  if (leftScore !== rightScore) return rightScore - leftScore;
  const leftCost = left.reduce((sum, candidate) => sum + candidate.totalCents, 0);
  const rightCost = right.reduce((sum, candidate) => sum + candidate.totalCents, 0);
  if (leftCost !== rightCost) return leftCost - rightCost;
  return left.map((candidate) => candidate.canonical).join("|").localeCompare(
    right.map((candidate) => candidate.canonical).join("|"),
  );
}

function blockersFromCounters(
  counters: Record<OptimizationBlocker, number>,
  hasInventory: boolean,
  hasRecipeCandidates: boolean,
): OptimizationBlocker[] {
  if (!hasInventory) return ["NO_INVENTORY"];
  if (hasRecipeCandidates) {
    return [
      ...(counters.STOCK ? (["STOCK"] as const) : []),
      ...(counters.BUDGET ? (["BUDGET"] as const) : []),
      ...(counters.PICKUP_WINDOW ? (["PICKUP_WINDOW"] as const) : []),
    ];
  }
  const reasons: OptimizationBlocker[] = [];
  if (counters.UNKNOWN_ALLERGEN_DATA) reasons.push("UNKNOWN_ALLERGEN_DATA");
  if (counters.ALLERGEN_MISMATCH) reasons.push("ALLERGEN_MISMATCH");
  if (counters.DIETARY_RESTRICTION) reasons.push("DIETARY_RESTRICTION");
  if (counters.EXPIRED) reasons.push("EXPIRED");
  if (counters.PICKUP_WINDOW) reasons.push("PICKUP_WINDOW");
  return reasons.length ? reasons : ["NO_RECIPE_MATCH"];
}

function emptyCounters(): Record<OptimizationBlocker, number> {
  return {
    INVALID_REQUEST: 0,
    NO_INVENTORY: 0,
    NO_RECIPE_MATCH: 0,
    BUDGET: 0,
    STOCK: 0,
    PICKUP_WINDOW: 0,
    EXPIRED: 0,
    DIETARY_RESTRICTION: 0,
    ALLERGEN_MISMATCH: 0,
    UNKNOWN_ALLERGEN_DATA: 0,
  };
}

/**
 * Search a bounded set of inventory-grounded meal candidates. Hard constraints
 * are checked before weighted preference scoring. No item or price is invented.
 */
export function optimizeBundles(
  preferences: PlannerPreferences,
  inventory: InventoryProduct[],
  options: OptimizerOptions = {},
): OptimizationResult {
  const startedAt = Date.now();
  const counters = emptyCounters();
  const maxBundles = Math.max(1, options.maxBundles ?? 3);
  const maxSearchNodes = Math.max(1, options.maxSearchNodes ?? DEFAULT_MAX_SEARCH_NODES);
  const valid = validatePreferences(preferences);
  const requested = preferences.storeId
    ? inventory.filter((product) => product.storeId === preferences.storeId)
    : inventory;
  const stores = [...new Set(requested.map((product) => product.storeId))].sort();
  const selections: Array<{ storeId: string; candidates: RecipeCandidate[] }> = [];
  let recipeCandidateCount = 0;
  let searchNodes = 0;
  let terminalPlanAttempts = 0;
  let searchTruncated = false;
  const hasInventory = requested.some((product) => product.quantityAvailable > 0 && validInventory(product));
  let feasiblePlanCount = 0;

  if (!valid) {
    counters.INVALID_REQUEST += 1;
    return {
      feasible: false,
      bundles: [],
      blockers: ["INVALID_REQUEST"],
      metrics: {
        inventoryRecords: inventory.length,
        storesConsidered: stores.length,
        recipeCandidates: 0,
        searchNodes: 0,
        terminalPlanAttempts: 0,
        feasiblePlans: 0,
        constraintViolations: 0,
        feasibilityRate: 0,
        searchTruncated: false,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  for (const storeId of stores) {
    const storeProducts = requested.filter((product) => product.storeId === storeId);
    const candidates = makeRecipeCandidates(
      storeProducts,
      preferences,
      options.now ?? new Date(),
      counters,
    );
    recipeCandidateCount += candidates.length;
    candidates.sort((a, b) => b.score - a.score || a.canonical.localeCompare(b.canonical));
    const bounded = candidates.slice(0, MAX_RECIPE_CANDIDATES_PER_STORE);
    if (candidates.length > bounded.length) searchTruncated = true;
    const chosen: RecipeCandidate[] = [];
    const uniqueSelections = new Map<string, RecipeCandidate[]>();

    const search = (startIndex: number, used: Map<string, number>, runningCents: number) => {
      if (searchNodes >= maxSearchNodes) {
        searchTruncated = true;
        return;
      }
      searchNodes += 1;
      if (chosen.length === preferences.mealCount) {
        terminalPlanAttempts += 1;
        const pickup = selectionPickup(chosen);
        if (!pickup) {
          counters.PICKUP_WINDOW += 1;
          return;
        }
        const key = chosen.map((candidate) => candidate.canonical).join("|");
        uniqueSelections.set(key, [...chosen]);
        return;
      }
      for (let index = startIndex; index < bounded.length; index += 1) {
        const candidate = bounded[index];
        const total = runningCents + candidate.totalCents;
        if (total > preferences.budgetCents) {
          counters.BUDGET += 1;
          continue;
        }
        let stockOkay = true;
        candidate.products.forEach((product, productIndex) => {
          const nextQuantity = (used.get(product.id) ?? 0) + candidate.quantities[productIndex];
          if (nextQuantity > product.quantityAvailable) stockOkay = false;
        });
        if (!stockOkay) {
          counters.STOCK += 1;
          continue;
        }
        const pickup = chosen.length ? intersectWindows(chosen[0].pickup, candidate.pickup) : candidate.pickup;
        if (!pickup || chosen.some((item) => !intersectWindows(item.pickup, candidate.pickup))) {
          counters.PICKUP_WINDOW += 1;
          continue;
        }
        candidate.products.forEach((product, productIndex) => {
          used.set(product.id, (used.get(product.id) ?? 0) + candidate.quantities[productIndex]);
        });
        chosen.push(candidate);
        search(index, used, total);
        chosen.pop();
        candidate.products.forEach((product, productIndex) => {
          const remaining = (used.get(product.id) ?? 0) - candidate.quantities[productIndex];
          if (remaining === 0) used.delete(product.id);
          else used.set(product.id, remaining);
        });
        if (searchNodes >= maxSearchNodes) {
          searchTruncated = true;
          return;
        }
      }
    };

    if (bounded.length > 0) search(0, new Map(), 0);
    const storeSelections = [...uniqueSelections.values()].sort(compareSelections);
    feasiblePlanCount += uniqueSelections.size;
    for (const selection of storeSelections.slice(0, maxBundles)) selections.push({ storeId, candidates: selection });
  }

  selections.sort((a, b) => compareSelections(a.candidates, b.candidates));
  const topSelections = selections.slice(0, maxBundles);
  const bundles = topSelections.map(({ storeId, candidates }) =>
    bundleFromSelection(
      storeId,
      requested.filter((product) => product.storeId === storeId),
      candidates,
      preferences,
      options.storeNames,
    ),
  );
  const feasiblePlans = feasiblePlanCount;
  const blockers: OptimizationBlocker[] = bundles.length
    ? []
    : !hasInventory
      ? ["NO_INVENTORY"]
      : blockersFromCounters(counters, hasInventory, recipeCandidateCount > 0);
  return {
    feasible: bundles.length > 0,
    bundles,
    blockers,
    metrics: {
      inventoryRecords: inventory.length,
      storesConsidered: stores.length,
      recipeCandidates: recipeCandidateCount,
      searchNodes,
      terminalPlanAttempts,
      feasiblePlans,
      constraintViolations: 0,
      feasibilityRate: terminalPlanAttempts ? feasiblePlans / terminalPlanAttempts : 0,
      searchTruncated,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

/**
 * Baseline comparator: greedily choose the highest-discount recipe candidate
 * that still meets the same hard constraints. It does not backtrack, so it can
 * miss feasible plans that the optimizer finds.
 */
export function greedyDiscountBaseline(
  preferences: PlannerPreferences,
  inventory: InventoryProduct[],
  options: Pick<OptimizerOptions, "now"> = {},
): GreedyBaselineResult {
  if (!validatePreferences(preferences)) {
    return {
      feasible: false,
      selectedInventoryIds: [],
      totalCents: 0,
      mealCount: 0,
      reason: "Invalid budget, serving count, pickup date, or meal count.",
    };
  }
  const requested = preferences.storeId
    ? inventory.filter((product) => product.storeId === preferences.storeId)
    : inventory;
  const counters = emptyCounters();
  const stores = [...new Set(requested.map((product) => product.storeId))].sort();
  for (const storeId of stores) {
    const products = requested.filter((product) => product.storeId === storeId);
    const candidates = makeRecipeCandidates(products, preferences, options.now ?? new Date(), counters);
    candidates.sort((a, b) => {
      const discountA = a.originalCents - a.totalCents;
      const discountB = b.originalCents - b.totalCents;
      return discountB - discountA || a.totalCents - b.totalCents || a.canonical.localeCompare(b.canonical);
    });
    const selected: RecipeCandidate[] = [];
    const used = new Map<string, number>();
    let totalCents = 0;
    while (selected.length < preferences.mealCount) {
      const next = candidates.find((candidate) => {
        if (totalCents + candidate.totalCents > preferences.budgetCents) return false;
        if (selected.some((meal) => !intersectWindows(meal.pickup, candidate.pickup))) return false;
        return candidate.products.every(
          (product, index) => (used.get(product.id) ?? 0) + candidate.quantities[index] <= product.quantityAvailable,
        );
      });
      if (!next) break;
      selected.push(next);
      totalCents += next.totalCents;
      next.products.forEach((product, index) => {
        used.set(product.id, (used.get(product.id) ?? 0) + next.quantities[index]);
      });
    }
    if (selected.length === preferences.mealCount) {
      return {
        feasible: true,
        storeId,
        selectedInventoryIds: [...used.keys()].sort(),
        totalCents,
        mealCount: selected.length,
      };
    }
  }
  return {
    feasible: false,
    selectedInventoryIds: [],
    totalCents: 0,
    mealCount: 0,
    reason: "Greedy discount ranking could not satisfy all hard constraints.",
  };
}

export function compareWithGreedyBaseline(
  result: OptimizationResult,
  preferences: PlannerPreferences,
  inventory: InventoryProduct[],
  options: Pick<OptimizerOptions, "now"> = {},
): BenchmarkComparison {
  const bundle = result.bundles[0];
  return {
    optimizer: {
      feasible: result.feasible,
      ...(bundle
        ? { totalCents: bundle.totalCents, savingsCents: bundle.savingsCents }
        : {}),
    },
    greedyDiscountBaseline: greedyDiscountBaseline(preferences, inventory, options),
  };
}

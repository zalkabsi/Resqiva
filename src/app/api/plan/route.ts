import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { isSameOriginMutation, readSessionFromRequest } from "@/lib/auth";
import { optimizeBundles } from "@/lib/optimizer";
import type { InventoryProduct, PlannerPreferences } from "@/lib/contracts";
import { expireStaleReservations } from "@/lib/reservations";

export const runtime = "nodejs";
export const maxDuration = 20;

const preferenceSchema = z.object({
  budgetCents: z.number().int().min(100).max(100_000),
  servings: z.number().int().min(1).max(12),
  mealCount: z.number().int().min(1).max(7),
  exclusions: z.array(z.string().trim().min(1).max(60)).max(12),
  allergies: z.array(z.string().trim().min(1).max(60)).max(12),
  preferredIngredients: z.array(z.string().trim().min(1).max(60)).max(20),
  avoidIngredients: z.array(z.string().trim().min(1).max(60)).max(20),
  pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  storeId: z.string().min(1).max(128).optional(),
  sourceText: z.string().trim().min(1).max(1500),
}).strict();

const requestSchema = z.object({ preferences: preferenceSchema }).strict();

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not accepted." }, { status: 403 });
  }
  const session = readSessionFromRequest(request);
  if (!session || session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "Start a demo shopper session to plan a meal." }, { status: 401 });
  }

  const body = await readBoundedJson(request, 24 * 1024);
  if (!body.ok) return NextResponse.json({ error: body.message }, { status: body.status });
  const input = requestSchema.safeParse(body.value);
  if (!input.success) {
    return NextResponse.json(
      { error: "Check that the budget, servings, meal count, and pickup date are within the supported ranges." },
      { status: 400 },
    );
  }
  const preferences = input.data.preferences as PlannerPreferences;
  if (!isValidDate(preferences.pickupDate)) {
    return NextResponse.json({ error: "The pickup date is not a valid calendar date." }, { status: 400 });
  }
  if (preferences.pickupDate < todayInRiyadh()) {
    return NextResponse.json({ error: "Pickup cannot be planned for a date that has already passed in Riyadh." }, { status: 400 });
  }

  try {
    const db = getDb();
    await expireStaleReservations();
    const now = new Date();
    const stores = await db.store.findMany({
      where: {
        isDemo: true,
        ...(preferences.storeId ? { id: preferences.storeId } : {}),
      },
      include: {
        merchant: { select: { name: true } },
        pickupWindows: {
          where: { active: true, endsAt: { gt: now } },
          orderBy: { startsAt: "asc" },
        },
        inventoryLots: {
          where: { sellable: true },
          include: { product: true },
        },
      },
    });
    if (preferences.storeId && stores.length === 0) {
      return NextResponse.json({ error: "That demo store is unavailable. Refresh the store list and try again." }, { status: 404 });
    }

    const pickupByStore = new Map<string, (typeof stores)[number]["pickupWindows"][number]>();
    const eligibleStores = stores.filter((store) => {
      const pickup = store.pickupWindows.find((window) =>
        window.startsAt > now
        && window.endsAt > now
        && window.reservedUnits < window.capacityUnits
        && localDateKey(window.startsAt, store.timezone) === preferences.pickupDate,
      );
      if (!pickup) return false;
      pickupByStore.set(store.id, pickup);
      return true;
    });
    if (eligibleStores.length === 0) {
      return NextResponse.json({
        bundles: [],
        reason: `No active pickup window is available on ${preferences.pickupDate}. Choose an upcoming pickup date shown for the store.`,
        blockers: ["PICKUP_WINDOW"],
      });
    }

    const inventory: InventoryProduct[] = [];
    const storeNames: Record<string, string> = {};
    for (const store of eligibleStores) {
      const pickup = pickupByStore.get(store.id);
      if (!pickup) continue;
      storeNames[store.id] = store.name;
      for (const lot of store.inventoryLots) {
        const available = lot.quantityOnHand - lot.quantityReserved - lot.quantitySold;
        if (!lot.product.isActive || available < 1 || !lot.expiresAt || lot.expiresAt < pickup.endsAt) continue;
        if (
          !Number.isSafeInteger(lot.discountedPriceCents)
          || !Number.isSafeInteger(lot.originalPriceCents)
          || lot.discountedPriceCents < 0
          || lot.originalPriceCents < lot.discountedPriceCents
        ) continue;

        const allergenMetadata = lot.product.allergenDataStatus === "VERIFIED"
          ? (lot.product.knownAllergens.length ? [...lot.product.knownAllergens] : ["none"])
          : [...lot.product.knownAllergens, "unknown"];
        inventory.push({
          id: lot.id,
          storeId: store.id,
          name: lot.product.name,
          category: lot.product.category,
          priceCents: lot.discountedPriceCents,
          originalPriceCents: lot.originalPriceCents,
          quantityAvailable: available,
          allergens: allergenMetadata,
          dietaryTags: lot.product.dietaryTags,
          ingredients: lot.product.ingredients,
          expiresAt: lot.expiresAt.toISOString(),
          pickupStart: toZonedIso(pickup.startsAt, store.timezone),
          pickupEnd: toZonedIso(pickup.endsAt, store.timezone),
        });
      }
    }

    const result = optimizeBundles(preferences, inventory, { storeNames, maxBundles: 3, now });
    const blockers = result.blockers;
    const preferenceRecord = {
      budgetCents: preferences.budgetCents,
      servings: preferences.servings,
      mealCount: preferences.mealCount,
      exclusions: preferences.exclusions,
      allergies: preferences.allergies,
      preferredIngredients: preferences.preferredIngredients,
      avoidIngredients: preferences.avoidIngredients,
      pickupDate: preferences.pickupDate,
      storeId: preferences.storeId ?? null,
    } satisfies Prisma.InputJsonObject;
    const metricsRecord = {
      ...result.metrics,
      blockers,
      baseline: "greedy-discount-ranking",
      searchMethod: "bounded-depth-first-with-hard-constraints-before-weighted-score",
    } satisfies Prisma.InputJsonObject;
    const runStoreId = preferences.storeId
      ?? (new Set(result.bundles.map((bundle) => bundle.storeId)).size === 1 ? result.bundles[0]?.storeId : undefined);

    const saved = await db.$transaction(async (tx) => {
      const preference = await tx.customerPreference.create({
        data: {
          userId: session.userId,
          sourceText: "[request text intentionally not retained]",
          parsedPreferences: preferenceRecord,
          provider: "server-validation",
          model: "deterministic-input-v1",
        },
      });
      return tx.optimizationRun.create({
        data: {
          userId: session.userId,
          storeId: runStoreId,
          preferenceId: preference.id,
          status: result.feasible ? "COMPLETED" : "NO_FEASIBLE_BUNDLE",
          candidateCount: result.metrics.recipeCandidates,
          feasibleCount: result.metrics.feasiblePlans,
          selectedCount: result.bundles.length,
          constraintViolations: result.metrics.constraintViolations,
          objectiveWeights: {
            hardConstraintsPrecedeSoftScore: true,
            softScore: "savings, verified surplus quantity, preference match, and expiry urgency",
          },
          resultMetrics: metricsRecord,
          model: null,
          bundles: {
            create: result.bundles.map((bundle) => {
              const pickup = pickupByStore.get(bundle.storeId);
              if (!pickup) throw new Error("The selected plan has no matching pickup window.");
              return {
                userId: session.userId,
                storeId: bundle.storeId,
                pickupWindowId: pickup.id,
                status: "PENDING",
                mealCount: bundle.meals.length,
                servings: preferences.servings,
                totalCents: bundle.totalCents,
                originalTotalCents: bundle.originalTotalCents,
                savingsCents: bundle.savingsCents,
                verifiedSurplusUnits: bundle.verifiedSurplusUnits,
                explanation: bundle.explanation,
                items: {
                  create: bundle.items.map((item) => ({
                    inventoryLotId: item.inventoryId,
                    quantity: item.quantity,
                    unitPriceCents: item.unitPriceCents,
                    originalUnitPriceCents: item.originalUnitPriceCents,
                  })),
                },
                meals: {
                  create: bundle.meals.map((meal) => ({
                    title: meal.title,
                    servings: meal.servings,
                    itemNames: meal.itemNames,
                    pantryStaples: meal.pantryStaples,
                    instructions: meal.instructions as Prisma.InputJsonValue,
                  })),
                },
              };
            }),
          },
        },
        include: {
          bundles: {
            include: {
              store: true,
              pickupWindow: true,
              items: { include: { inventoryLot: { include: { product: true } } } },
              meals: true,
            },
          },
        },
      });
    });

    return NextResponse.json({
      bundles: saved.bundles.map((bundle) => ({
        id: bundle.id,
        storeId: bundle.storeId,
        storeName: bundle.store.name,
        items: bundle.items.map((item) => ({
          inventoryId: item.inventoryLotId,
          productName: item.inventoryLot.product.name,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          originalUnitPriceCents: item.originalUnitPriceCents,
        })),
        meals: bundle.meals.map((meal) => ({
          title: meal.title,
          servings: meal.servings,
          itemNames: meal.itemNames,
          pantryStaples: meal.pantryStaples,
          instructions: Array.isArray(meal.instructions) ? meal.instructions.filter((item): item is string => typeof item === "string") : [],
        })),
        totalCents: bundle.totalCents,
        originalTotalCents: bundle.originalTotalCents,
        savingsCents: bundle.savingsCents,
        verifiedSurplusUnits: bundle.verifiedSurplusUnits,
        pickupStart: bundle.pickupWindow ? toZonedIso(bundle.pickupWindow.startsAt, bundle.store.timezone) : "",
        pickupEnd: bundle.pickupWindow ? toZonedIso(bundle.pickupWindow.endsAt, bundle.store.timezone) : "",
        explanation: bundle.explanation,
      })),
      reason: result.feasible ? undefined : reasonForBlockers(blockers),
      blockers,
      metrics: result.metrics,
    });
  } catch {
    return NextResponse.json(
      { error: "Meal planning is temporarily unavailable. No inventory or payment state was changed." },
      { status: 503 },
    );
  }
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: number; message: string }
> {
  if (!request.body) return { ok: false, status: 400, message: "Request body is required." };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, message: "Request body is too large." };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, message: "Request body could not be read." };
  }
  try {
    const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400, message: "Request body must be valid JSON." };
  }
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function todayInRiyadh(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function localDateKey(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function toZonedIso(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "00";
  const offset = part("timeZoneName") === "GMT" ? "Z" : part("timeZoneName").replace(/^GMT/, "");
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${offset}`;
}

function reasonForBlockers(blockers: string[]): string {
  if (blockers.includes("UNKNOWN_ALLERGEN_DATA")) {
    return "No bundle could be confirmed because allergen records are incomplete for the selected allergy. Choose products with verified labels or remove the allergy filter only if appropriate.";
  }
  if (blockers.includes("ALLERGEN_MISMATCH")) return "No bundle met the listed allergen exclusions.";
  if (blockers.includes("BUDGET")) return "No complete meal set fits this budget. Try fewer meals or a higher budget.";
  if (blockers.includes("STOCK")) return "There is not enough stock for the requested number of meals. Try fewer servings or another pickup date.";
  if (blockers.includes("DIETARY_RESTRICTION")) return "No listed meal set met the selected dietary constraints.";
  if (blockers.includes("EXPIRED")) return "The matching items will not remain within their listed dates through pickup.";
  return "No available inventory combination met every requirement. Try a different date, store, or meal count.";
}

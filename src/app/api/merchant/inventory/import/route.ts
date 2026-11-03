import { NextResponse } from "next/server";
import { AllergenDataStatus, ExpirationType } from "@/generated/prisma/client";
import { getDb } from "@/lib/db";
import { authorizeDemoMerchant, sameOriginRequired } from "@/lib/merchant-auth";

export const runtime = "nodejs";

const MAX_BYTES = 256 * 1024;
const MAX_ROWS = 500;
const REQUIRED_HEADERS = ["sku", "name", "category", "quantity", "pricecents", "originalpricecents", "expiresat"];
const OPTIONAL_HEADERS = ["ingredients", "allergens", "allergendatastatus", "dietarytags", "expirationtype"];
const ALLOWED_HEADERS = new Set([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);
const VALID_DIETARY_TAGS = new Set(["VEGETARIAN", "VEGAN", "GLUTEN_FREE", "DAIRY_FREE", "HALAL", "LOW_SODIUM"]);

type InventoryRow = {
  sku: string;
  name: string;
  category: string;
  quantity: number;
  priceCents: number;
  originalPriceCents: number;
  expiresAt: Date | null;
  ingredients: string[];
  allergens: string[];
  allergenDataStatus: AllergenDataStatus;
  dietaryTags: string[];
  expirationType: ExpirationType;
};

export async function POST(request: Request) {
  const originError = sameOriginRequired(request);
  if (originError) return originError;
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "text/csv" && contentType !== "application/csv") {
    return NextResponse.json({ error: "Upload a CSV request body with Content-Type text/csv." }, { status: 415 });
  }
  const requestedStoreId = new URL(request.url).searchParams.get("storeId");
  if (requestedStoreId && !/^[A-Za-z0-9_-]{8,128}$/.test(requestedStoreId)) {
    return NextResponse.json({ error: "Store reference is invalid." }, { status: 400 });
  }

  let csv: string;
  try {
    csv = await readBoundedText(request, MAX_BYTES);
  } catch {
    return NextResponse.json({ error: "CSV must be smaller than 256 KB." }, { status: 413 });
  }
  const parsed = parseInventoryCsv(csv);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const db = getDb();
    const { merchantId, userId } = authorization.context;
    const store = await db.store.findFirst({
      where: {
        ...(requestedStoreId ? { id: requestedStoreId } : {}),
        merchantId,
        isDemo: true,
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!store) {
      return requestedStoreId
        ? NextResponse.json({ error: "The selected store is not owned by this demo merchant." }, { status: 403 })
        : NextResponse.json({ error: "This demo merchant has no store available for inventory import." }, { status: 409 });
    }

    const imported = await db.$transaction(async (tx) => {
      let count = 0;
      for (const row of parsed.rows) {
        const existing = await tx.product.findUnique({ where: { sku: row.sku }, select: { id: true, merchantId: true } });
        if (existing && existing.merchantId !== merchantId) throw new CsvConflictError("A SKU in this file belongs to a different merchant.");

        const product = existing
          ? await tx.product.update({
              where: { id: existing.id },
              data: {
                name: row.name,
                category: row.category,
                description: "Fictional surplus listing imported by the demo merchant.",
                ingredients: row.ingredients,
                knownAllergens: row.allergens,
                allergenDataStatus: row.allergenDataStatus,
                dietaryTags: row.dietaryTags,
                isDemo: true,
                isActive: true,
              },
              select: { id: true },
            })
          : await tx.product.create({
              data: {
                merchantId,
                sku: row.sku,
                name: row.name,
                category: row.category,
                description: "Fictional surplus listing imported by the demo merchant.",
                ingredients: row.ingredients,
                knownAllergens: row.allergens,
                allergenDataStatus: row.allergenDataStatus,
                dietaryTags: row.dietaryTags,
                isDemo: true,
                isActive: true,
              },
              select: { id: true },
            });

        const lotCode = `CSV-${row.sku}`;
        const sellable = row.expiresAt !== null
          && row.expiresAt > new Date()
          && row.expirationType !== ExpirationType.UNKNOWN;
        await tx.inventoryLot.upsert({
          where: { storeId_productId_lotCode: { storeId: store.id, productId: product.id, lotCode } },
          create: {
            storeId: store.id,
            productId: product.id,
            lotCode,
            quantityOnHand: row.quantity,
            discountedPriceCents: row.priceCents,
            originalPriceCents: row.originalPriceCents,
            currency: "USD",
            expiresAt: row.expiresAt,
            expirationType: row.expirationType,
            sellable,
            notes: "Fictional demo inventory imported from merchant CSV.",
          },
          update: {
            quantityOnHand: row.quantity,
            discountedPriceCents: row.priceCents,
            originalPriceCents: row.originalPriceCents,
            expiresAt: row.expiresAt,
            expirationType: row.expirationType,
            sellable,
            notes: "Fictional demo inventory imported from merchant CSV.",
          },
        });
        count += 1;
      }

      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          actorType: "MERCHANT",
          action: "DEMO_INVENTORY_CSV_IMPORTED",
          entityType: "Store",
          entityId: store.id,
          metadata: { rowCount: count },
        },
      });
      return count;
    }, { isolationLevel: "Serializable" });

    return NextResponse.json({ importedCount: imported, message: `Imported ${imported} fictional demo listings.` });
  } catch (error) {
    if (error instanceof CsvConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "CSV import could not be saved. Refresh inventory and try again." }, { status: 503 });
  }
}

class CsvConflictError extends Error {}

async function readBoundedText(request: Request, limit: number): Promise<string> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) throw new Error("body too large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("body too large");
    }
    chunks.push(result.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

function parseInventoryCsv(text: string): { ok: true; rows: InventoryRow[] } | { ok: false; error: string } {
  const matrix = parseCsvMatrix(text.replace(/^\uFEFF/, ""));
  if (!matrix.ok) return matrix;
  if (matrix.rows.length < 2) return { ok: false, error: "CSV must include a header and at least one inventory row." };
  if (matrix.rows.length - 1 > MAX_ROWS) return { ok: false, error: "CSV cannot contain more than 500 inventory rows." };
  const headers = matrix.rows[0].map((value) => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length || headers.some((header) => !ALLOWED_HEADERS.has(header))) {
    return { ok: false, error: "CSV headers contain duplicates or unsupported columns." };
  }
  if (REQUIRED_HEADERS.some((header) => !headers.includes(header))) {
    return { ok: false, error: `CSV must include these columns: ${REQUIRED_HEADERS.join(", ")}.` };
  }
  const index = new Map(headers.map((header, position) => [header, position]));
  const seenSkus = new Set<string>();
  const rows: InventoryRow[] = [];

  for (const cells of matrix.rows.slice(1)) {
    if (cells.length !== headers.length || cells.every((cell) => !cell.trim())) {
      return { ok: false, error: "Every row must have one value for each declared column." };
    }
    if (cells.some((cell) => cell.length > 500)) return { ok: false, error: "CSV field values are limited to 500 characters." };
    const value = (header: string) => cells[index.get(header) ?? -1]?.trim() ?? "";
    const sku = value("sku");
    const name = value("name");
    const category = value("category").toLowerCase();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(sku) || !name || name.length > 120 || !/^[a-z0-9 _-]{1,40}$/.test(category)) {
      return { ok: false, error: "CSV contains an invalid SKU, product name, or category." };
    }
    if (seenSkus.has(sku)) return { ok: false, error: "CSV contains a duplicate SKU." };
    seenSkus.add(sku);
    const quantity = Number(value("quantity"));
    const priceCents = Number(value("pricecents"));
    const originalPriceCents = Number(value("originalpricecents"));
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 10_000
      || !Number.isInteger(priceCents) || priceCents < 1 || priceCents > 1_000_000
      || !Number.isInteger(originalPriceCents) || originalPriceCents < priceCents || originalPriceCents > 1_000_000) {
      return { ok: false, error: "CSV quantity and cent prices are outside supported limits." };
    }

    const expiryText = value("expiresat");
    let expiresAt: Date | null = null;
    if (expiryText) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryText)) return { ok: false, error: "Expiry dates must use YYYY-MM-DD format." };
      expiresAt = new Date(`${expiryText}T23:59:59.999Z`);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString().slice(0, 10) !== expiryText) {
        return { ok: false, error: "CSV contains an invalid calendar expiry date." };
      }
    }

    const ingredients = splitList(value("ingredients"));
    const allergens = splitList(value("allergens"));
    const requestedStatus = value("allergendatastatus").toUpperCase();
    if (requestedStatus && !Object.values(AllergenDataStatus).includes(requestedStatus as AllergenDataStatus)) {
      return { ok: false, error: "Allergen data status must be VERIFIED, PARTIAL, or UNKNOWN." };
    }
    const allergenDataStatus = Object.values(AllergenDataStatus).includes(requestedStatus as AllergenDataStatus)
      ? requestedStatus as AllergenDataStatus
      : AllergenDataStatus.UNKNOWN;
    const requestedExpirationType = value("expirationtype").toUpperCase();
    if (requestedExpirationType && !Object.values(ExpirationType).includes(requestedExpirationType as ExpirationType)) {
      return { ok: false, error: "Expiration type must be USE_BY, SELL_BY, BEST_BEFORE, EXPIRATION, or UNKNOWN." };
    }
    const expirationType = Object.values(ExpirationType).includes(requestedExpirationType as ExpirationType)
      ? requestedExpirationType as ExpirationType
      : ExpirationType.UNKNOWN;
    const dietaryTags = splitList(value("dietarytags")).map((tag) => tag.toUpperCase().replaceAll("-", "_"));
    if (dietaryTags.some((tag) => !VALID_DIETARY_TAGS.has(tag))) {
      return { ok: false, error: "CSV contains an unsupported dietary tag." };
    }
    rows.push({ sku, name, category, quantity, priceCents, originalPriceCents, expiresAt, ingredients, allergens, allergenDataStatus, dietaryTags, expirationType });
  }

  return { ok: true, rows };
}

function splitList(value: string): string[] {
  return value.split(";").map((item) => item.trim()).filter(Boolean).map((item) => item.slice(0, 80));
}

function parseCsvMatrix(text: string): { ok: true; rows: string[][] } | { ok: false; error: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"') {
      if (cell.length > 0) return { ok: false, error: "CSV quoting is malformed." };
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length > MAX_ROWS + 1) return { ok: false, error: "CSV cannot contain more than 500 inventory rows." };
    } else {
      cell += character;
    }
  }
  if (quoted) return { ok: false, error: "CSV quoting is malformed." };
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  if (rows.length > MAX_ROWS + 1) return { ok: false, error: "CSV cannot contain more than 500 inventory rows." };
  return { ok: true, rows };
}

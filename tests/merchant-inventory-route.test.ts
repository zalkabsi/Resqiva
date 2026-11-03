import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeDemoMerchant: vi.fn(),
  sameOriginRequired: vi.fn(),
  checkMerchantMutationLimit: vi.fn(),
  storeFindFirst: vi.fn(),
  lotFindFirst: vi.fn(),
  lotFindUnique: vi.fn(),
  lotUpdateMany: vi.fn(),
  lotCreate: vi.fn(),
  productFindUnique: vi.fn(),
  productUpdate: vi.fn(),
  productCreate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/merchant-auth", () => ({
  authorizeDemoMerchant: mocks.authorizeDemoMerchant,
  sameOriginRequired: mocks.sameOriginRequired,
}));

vi.mock("@/lib/merchant-mutation-limit", () => ({
  checkMerchantMutationLimit: mocks.checkMerchantMutationLimit,
  merchantRateLimitResponse: (_scope: string, retryAfterSeconds: number) => new Response(
    JSON.stringify({ error: "Rate limited." }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(retryAfterSeconds) } },
  ),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    store: { findFirst: mocks.storeFindFirst },
    inventoryLot: { findFirst: mocks.lotFindFirst },
    $transaction: mocks.transaction,
  }),
}));

import { PATCH } from "@/app/api/merchant/inventory/[lotId]/route";
import { POST as importInventory } from "@/app/api/merchant/inventory/import/route";

const authorization = {
  ok: true as const,
  context: { userId: "merchant-user", merchantId: "merchant-123", role: "MERCHANT_ADMIN" as const },
};

function lotSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "lot-12345678",
    storeId: "store-12345678",
    quantityOnHand: 12,
    quantityReserved: 2,
    quantitySold: 1,
    discountedPriceCents: 400,
    originalPriceCents: 600,
    expiresAt: new Date("2030-01-01T23:59:59.999Z"),
    sellable: true,
    ...overrides,
  };
}

function tx() {
  return {
    inventoryLot: {
      findUnique: mocks.lotFindUnique,
      updateMany: mocks.lotUpdateMany,
      create: mocks.lotCreate,
    },
    product: {
      findUnique: mocks.productFindUnique,
      update: mocks.productUpdate,
      create: mocks.productCreate,
    },
    auditEvent: { create: mocks.auditCreate },
  };
}

function patchRequest(body: unknown) {
  return new Request("https://resqiva.test/api/merchant/inventory/lot-12345678", {
    method: "PATCH",
    headers: { Origin: "https://resqiva.test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function importRequest(csv = [
  "sku,name,category,quantity,priceCents,originalPriceCents,expiresAt,expirationType",
  "owned-sku,Surplus meal,meal,4,400,600,2030-01-01,USE_BY",
].join("\n")) {
  return new Request("https://resqiva.test/api/merchant/inventory/import?storeId=store-12345678", {
    method: "POST",
    headers: { Origin: "https://resqiva.test", "Content-Type": "text/csv" },
    body: csv,
  });
}

describe("merchant inventory mutation concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sameOriginRequired.mockReturnValue(null);
    mocks.authorizeDemoMerchant.mockResolvedValue(authorization);
    mocks.checkMerchantMutationLimit.mockReturnValue({ allowed: true, remaining: 29, retryAfterSeconds: 60 });
    mocks.storeFindFirst.mockResolvedValue({ id: "store-12345678" });
    mocks.lotFindFirst.mockResolvedValue(lotSnapshot());
    mocks.lotFindUnique.mockResolvedValue(lotSnapshot());
    mocks.lotUpdateMany.mockResolvedValue({ count: 0 });
    mocks.lotCreate.mockResolvedValue(undefined);
    mocks.productFindUnique.mockResolvedValue({ id: "product-12345678", merchantId: "merchant-123", isDemo: true });
    mocks.productUpdate.mockResolvedValue({ id: "product-12345678" });
    mocks.productCreate.mockResolvedValue({ id: "product-12345678" });
    mocks.auditCreate.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation((callback: (value: ReturnType<typeof tx>) => unknown) => callback(tx()));
  });

  it("rejects a PATCH quantity below reservations and sold units", async () => {
    mocks.lotFindFirst.mockResolvedValue(lotSnapshot({ quantityReserved: 3, quantitySold: 2 }));

    const response = await PATCH(patchRequest({ quantityOnHand: 4 }), { params: Promise.resolve({ lotId: "lot-12345678" }) });

    expect(response.status).toBe(409);
    expect(mocks.lotFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: "lot-12345678",
        store: { merchantId: "merchant-123", isDemo: true },
        product: { merchantId: "merchant-123", isDemo: true },
      },
    }));
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.lotUpdateMany).not.toHaveBeenCalled();
  });

  it("rate-limits inventory PATCH before loading the lot or reading the body", async () => {
    mocks.checkMerchantMutationLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 23 });

    const response = await PATCH(patchRequest({ quantityOnHand: 20 }), { params: Promise.resolve({ lotId: "lot-12345678" }) });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("23");
    expect(mocks.checkMerchantMutationLimit).toHaveBeenCalledWith("merchant-user", "inventory-patch", 30);
    expect(mocks.lotFindFirst).not.toHaveBeenCalled();
  });

  it("rate-limits CSV imports before opening an inventory transaction", async () => {
    mocks.checkMerchantMutationLimit.mockReturnValue({ allowed: false, remaining: 0, retryAfterSeconds: 41 });

    const response = await importInventory(importRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("41");
    expect(mocks.checkMerchantMutationLimit).toHaveBeenCalledWith("merchant-user", "inventory-import", 5);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.storeFindFirst).not.toHaveBeenCalled();
  });

  it("CASes every mutable lot field and writes only fields included in PATCH", async () => {
    const snapshot = lotSnapshot();
    mocks.lotFindFirst.mockResolvedValue(snapshot);

    const response = await PATCH(patchRequest({ discountedPriceCents: 350 }), { params: Promise.resolve({ lotId: snapshot.id }) });

    expect(response.status).toBe(409);
    expect(mocks.lotUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: snapshot.id,
        quantityOnHand: snapshot.quantityOnHand,
        quantityReserved: snapshot.quantityReserved,
        quantitySold: snapshot.quantitySold,
        discountedPriceCents: snapshot.discountedPriceCents,
        originalPriceCents: snapshot.originalPriceCents,
        expiresAt: snapshot.expiresAt,
        sellable: snapshot.sellable,
        store: { merchantId: "merchant-123", isDemo: true },
        product: { merchantId: "merchant-123", isDemo: true },
      }),
      data: { discountedPriceCents: 350 },
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects CSV stock below the existing reserved and sold commitments", async () => {
    mocks.lotFindUnique.mockResolvedValue(lotSnapshot({ quantityReserved: 3, quantitySold: 2 }));

    const response = await importInventory(importRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Imported quantity cannot be lower than units already reserved or sold." });
    expect(mocks.lotUpdateMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects CSV updates to a same-merchant non-demo product", async () => {
    mocks.productFindUnique.mockResolvedValue({ id: "product-12345678", merchantId: "merchant-123", isDemo: false });

    const response = await importInventory(importRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "A SKU in this file belongs to a non-demo product and cannot be imported." });
    expect(mocks.productUpdate).not.toHaveBeenCalled();
    expect(mocks.lotCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing expiration type header",
      csv: [
        "sku,name,category,quantity,priceCents,originalPriceCents,expiresAt",
        "owned-sku,Surplus meal,meal,4,400,600,2030-01-01",
      ].join("\n"),
      message: "CSV must include these columns: sku, name, category, quantity, pricecents, originalpricecents, expiresat, expirationtype.",
    },
    {
      name: "missing expiration type",
      csv: [
        "sku,name,category,quantity,priceCents,originalPriceCents,expiresAt,expirationType",
        "owned-sku,Surplus meal,meal,4,400,600,2030-01-01,",
      ].join("\n"),
      message: "Expiration type must be USE_BY, SELL_BY, BEST_BEFORE, EXPIRATION, or UNKNOWN.",
    },
    {
      name: "unknown expiration type",
      csv: [
        "sku,name,category,quantity,priceCents,originalPriceCents,expiresAt,expirationType",
        "owned-sku,Surplus meal,meal,4,400,600,2030-01-01,UNKNOWN",
      ].join("\n"),
      message: "A known expiration type is required for a sellable inventory listing.",
    },
    {
      name: "missing expiry date",
      csv: [
        "sku,name,category,quantity,priceCents,originalPriceCents,expiresAt,expirationType",
        "owned-sku,Surplus meal,meal,4,400,600,,USE_BY",
      ].join("\n"),
      message: "CSV expiry date is required for a sellable listing.",
    },
    {
      name: "past expiry date",
      csv: [
        "sku,name,category,quantity,priceCents,originalPriceCents,expiresAt,expirationType",
        "owned-sku,Surplus meal,meal,4,400,600,2000-01-01,USE_BY",
      ].join("\n"),
      message: "CSV expiry date must be in the future for a sellable listing.",
    },
  ])("rejects CSV rows with $name", async ({ csv, message }) => {
    const response = await importInventory(importRequest(csv));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("uses a full lot snapshot CAS for CSV upserts so concurrent holds cannot be overwritten", async () => {
    const snapshot = lotSnapshot();
    mocks.lotFindUnique.mockResolvedValue(snapshot);
    mocks.lotUpdateMany.mockResolvedValue({ count: 0 });

    const response = await importInventory(importRequest());

    expect(response.status).toBe(409);
    expect(mocks.lotUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: snapshot.id,
        quantityOnHand: snapshot.quantityOnHand,
        quantityReserved: snapshot.quantityReserved,
        quantitySold: snapshot.quantitySold,
        discountedPriceCents: snapshot.discountedPriceCents,
        originalPriceCents: snapshot.originalPriceCents,
        expiresAt: snapshot.expiresAt,
        sellable: snapshot.sellable,
        storeId: snapshot.storeId,
        productId: "product-12345678",
        lotCode: "CSV-owned-sku",
      }),
    }));
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

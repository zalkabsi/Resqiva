import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isSameOriginMutation: vi.fn(),
  authorizeDemoMerchant: vi.fn(),
  sameOriginRequired: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  isSameOriginMutation: mocks.isSameOriginMutation,
  createSessionToken: vi.fn(),
  sessionCookie: vi.fn(),
}));
vi.mock("@/lib/merchant-auth", () => ({
  authorizeDemoMerchant: mocks.authorizeDemoMerchant,
  sameOriginRequired: mocks.sameOriginRequired,
}));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));

import { POST as createDemoSession } from "@/app/api/demo/session/route";
import { PATCH as updateInventory } from "@/app/api/merchant/inventory/[lotId]/route";
import { POST as createStore } from "@/app/api/merchant/stores/route";
import { PATCH as updateStore } from "@/app/api/merchant/stores/[storeId]/route";
import { POST as createPickupWindow } from "@/app/api/merchant/pickup-windows/route";
import { PATCH as updatePickupWindow } from "@/app/api/merchant/pickup-windows/[windowId]/route";

const admin = {
  ok: true as const,
  context: { userId: "demo-admin", merchantId: "demo-merchant", role: "MERCHANT_ADMIN" as const },
};

function request(path: string, bodySize: number, withOrigin = true) {
  return new Request(`https://resqiva.test${path}`, {
    method: "POST",
    headers: withOrigin ? { Origin: "https://resqiva.test", "Content-Type": "application/json" } : { "Content-Type": "application/json" },
    body: " ".repeat(bodySize),
  });
}

function patchRequest(path: string, bodySize: number) {
  return new Request(`https://resqiva.test${path}`, {
    method: "PATCH",
    headers: { Origin: "https://resqiva.test", "Content-Type": "application/json" },
    body: " ".repeat(bodySize),
  });
}

async function expectTooLarge(response: Response, shape: "session" | "merchant" = "merchant") {
  expect(response.status).toBe(413);
  if (shape === "session") {
    await expect(response.json()).resolves.toEqual({ error: { code: "invalid_request", message: "Request body is too large." } });
  } else {
    await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
  }
}

describe("bounded merchant and demo JSON routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSameOriginMutation.mockReturnValue(true);
    mocks.sameOriginRequired.mockReturnValue(null);
    mocks.authorizeDemoMerchant.mockResolvedValue(admin);
  });

  it("rejects oversized demo-session and inventory patches before database access", async () => {
    await expectTooLarge(await createDemoSession(request("/api/demo/session", 4 * 1024 + 1)), "session");
    await expectTooLarge(await updateInventory(patchRequest("/api/merchant/inventory/lot-12345678", 4 * 1024 + 1), { params: Promise.resolve({ lotId: "lot-12345678" }) }));
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("rejects oversized merchant store and pickup-window mutations before database access", async () => {
    await expectTooLarge(await createStore(request("/api/merchant/stores", 8 * 1024 + 1)));
    await expectTooLarge(await updateStore(patchRequest("/api/merchant/stores/store-12345678", 8 * 1024 + 1), { params: Promise.resolve({ storeId: "store-12345678" }) }));
    await expectTooLarge(await createPickupWindow(request("/api/merchant/pickup-windows", 8 * 1024 + 1)));
    await expectTooLarge(await updatePickupWindow(patchRequest("/api/merchant/pickup-windows/window-12345678", 8 * 1024 + 1), { params: Promise.resolve({ windowId: "window-12345678" }) }));
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("preserves malformed JSON errors for small mutation bodies", async () => {
    const malformed = new Request("https://resqiva.test/api/merchant/stores", {
      method: "POST",
      headers: { Origin: "https://resqiva.test", "Content-Type": "application/json" },
      body: "{",
    });
    const response = await createStore(malformed);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Request body must be valid JSON." });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
});

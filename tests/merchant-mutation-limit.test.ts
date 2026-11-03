import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkMerchantMutationLimit, merchantRateLimitResponse } from "@/lib/merchant-mutation-limit";

describe("merchant mutation limits", () => {
  it("limits a merchant by user and mutation scope", () => {
    const userId = `merchant-${randomUUID()}`;
    expect(checkMerchantMutationLimit(userId, "store-create", 1).allowed).toBe(true);
    expect(checkMerchantMutationLimit(userId, "store-create", 1).allowed).toBe(false);
    expect(checkMerchantMutationLimit(`${userId}-other`, "store-create", 1).allowed).toBe(true);
    expect(checkMerchantMutationLimit(userId, "store-update", 1).allowed).toBe(true);
  });

  it("returns a sanitized 429 response with Retry-After", async () => {
    const response = merchantRateLimitResponse("pickup-window-create", 37);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("37");
    await expect(response.json()).resolves.toEqual({
      error: "Too many pickup-window creation requests. Try again shortly.",
    });
  });
});

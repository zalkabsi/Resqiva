import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";

export type MerchantMutationScope =
  | "inventory-patch"
  | "inventory-import"
  | "store-create"
  | "store-update"
  | "pickup-window-create"
  | "pickup-window-update";

const RETRY_MESSAGES: Record<MerchantMutationScope, string> = {
  "inventory-patch": "Too many inventory updates. Try again shortly.",
  "inventory-import": "Too many inventory imports. Try again shortly.",
  "store-create": "Too many store creation requests. Try again shortly.",
  "store-update": "Too many store update requests. Try again shortly.",
  "pickup-window-create": "Too many pickup-window creation requests. Try again shortly.",
  "pickup-window-update": "Too many pickup-window update requests. Try again shortly.",
};

export function checkMerchantMutationLimit(userId: string, scope: MerchantMutationScope, limit: number) {
  return checkRateLimit(`merchant-mutation:${scope}:${userId}`, limit, 60_000);
}

export function merchantRateLimitResponse(scope: MerchantMutationScope, retryAfterSeconds: number): NextResponse {
  const retryAfter = Number.isSafeInteger(retryAfterSeconds) ? Math.max(1, retryAfterSeconds) : 60;
  return NextResponse.json(
    { error: RETRY_MESSAGES[scope] },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

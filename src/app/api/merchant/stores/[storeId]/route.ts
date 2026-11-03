import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authorizeDemoMerchant, sameOriginRequired } from "@/lib/merchant-auth";
import { updateMerchantStoreSchema, validateStoreChangeImpact } from "@/lib/merchant-store-rules";
import { checkMerchantMutationLimit, merchantRateLimitResponse } from "@/lib/merchant-mutation-limit";
import { readJsonLimited, RequestReadError } from "@/lib/request";

export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 8 * 1024;

type RouteContext = { params: Promise<{ storeId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const originError = sameOriginRequired(request);
  if (originError) return originError;
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;
  if (authorization.context.role !== "MERCHANT_ADMIN") {
    return NextResponse.json({ error: "A demo merchant administrator must edit store details." }, { status: 403 });
  }

  const { storeId } = await context.params;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(storeId)) {
    return NextResponse.json({ error: "Store reference is invalid." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await readJsonLimited(request, MAX_REQUEST_BYTES);
  } catch (error) {
    const tooLarge = error instanceof RequestReadError && error.status === 413;
    return NextResponse.json({ error: tooLarge ? "Request body is too large." : "Request body must be valid JSON." }, { status: tooLarge ? 413 : 400 });
  }
  const parsed = updateMerchantStoreSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Store changes are invalid." }, { status: 400 });

  try {
    const db = getDb();
    const { merchantId, userId } = authorization.context;
    const result = await db.$transaction(async (tx) => {
      const existing = await tx.store.findFirst({
        where: { id: storeId, merchantId, isDemo: true },
        select: { id: true, name: true, city: true, timezone: true, pickupAddress: true, updatedAt: true },
      });
      if (!existing) return { kind: "missing" as const };
      const rateLimit = checkMerchantMutationLimit(userId, "store-update", 30);
      if (!rateLimit.allowed) return { kind: "rate_limited" as const, retryAfterSeconds: rateLimit.retryAfterSeconds };

      const [liveReservations, liveOrders] = await Promise.all([
        tx.reservation.count({
          where: {
            storeId: existing.id,
            status: { in: ["PENDING", "RESERVED", "PAYMENT_APPROVED", "PAID", "PAYMENT_EXCEPTION"] },
          },
        }),
        tx.order.count({
          where: {
            storeId: existing.id,
            status: { in: ["PENDING", "PAYMENT_APPROVED", "PAID", "PAYMENT_EXCEPTION"] },
          },
        }),
      ]);

      const next = {
        name: parsed.data.name ?? existing.name,
        city: parsed.data.city ?? existing.city,
        timezone: parsed.data.timezone ?? existing.timezone,
        pickupAddress: parsed.data.pickupAddress ?? existing.pickupAddress,
      };
      const impactError = validateStoreChangeImpact(
        { name: existing.name, city: existing.city, timezone: existing.timezone, pickupAddress: existing.pickupAddress },
        next,
        { liveReservations, liveOrders },
      );
      if (impactError) return { kind: "invalid" as const, error: impactError };

      const updated = await tx.store.updateMany({
        where: {
          id: existing.id,
          merchantId,
          isDemo: true,
          updatedAt: existing.updatedAt,
        },
        data: next,
      });
      if (updated.count !== 1) return { kind: "raced" as const };

      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          actorType: "MERCHANT",
          action: "DEMO_STORE_UPDATED",
          entityType: "Store",
          entityId: existing.id,
          metadata: {
            addressOrTimezoneChanged: next.pickupAddress !== existing.pickupAddress || next.timezone !== existing.timezone,
          },
        },
      });
      return {
        kind: "updated" as const,
        store: await tx.store.findUniqueOrThrow({
          where: { id: existing.id },
          select: { id: true, slug: true, name: true, city: true, timezone: true, pickupAddress: true, createdAt: true, updatedAt: true },
        }),
      };
    }, { isolationLevel: "Serializable" });

    if (result.kind === "missing") return NextResponse.json({ error: "Store was not found for this demo merchant." }, { status: 404 });
    if (result.kind === "invalid") return NextResponse.json({ error: result.error }, { status: 409 });
    if (result.kind === "rate_limited") return merchantRateLimitResponse("store-update", result.retryAfterSeconds);
    if (result.kind === "raced") return NextResponse.json({ error: "Store details changed during this update. Refresh and retry." }, { status: 409 });
    return NextResponse.json({ store: { ...result.store, currency: "USD", isDemo: true, createdAt: result.store.createdAt.toISOString(), updatedAt: result.store.updatedAt.toISOString() } });
  } catch {
    return NextResponse.json({ error: "Store details could not be updated." }, { status: 503 });
  }
}

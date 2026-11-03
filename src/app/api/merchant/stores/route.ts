import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authorizeDemoMerchant, sameOriginRequired } from "@/lib/merchant-auth";
import { buildStoreSlug, createMerchantStoreSchema } from "@/lib/merchant-store-rules";
import { checkMerchantMutationLimit, merchantRateLimitResponse } from "@/lib/merchant-mutation-limit";
import { readJsonLimited, RequestReadError } from "@/lib/request";

export const runtime = "nodejs";
const MAX_REQUEST_BYTES = 8 * 1024;

export async function GET(request: Request) {
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;

  try {
    const stores = await getDb().store.findMany({
      where: { merchantId: authorization.context.merchantId, isDemo: true },
      include: { _count: { select: { inventoryLots: true, pickupWindows: true, orders: true } } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return NextResponse.json({
      stores: stores.map((store) => ({
        id: store.id,
        slug: store.slug,
        name: store.name,
        city: store.city,
        timezone: store.timezone,
        pickupAddress: store.pickupAddress,
        currency: "USD",
        isDemo: true,
        inventoryListings: store._count.inventoryLots,
        pickupWindowCount: store._count.pickupWindows,
        orderCount: store._count.orders,
        createdAt: store.createdAt.toISOString(),
        updatedAt: store.updatedAt.toISOString(),
      })),
    });
  } catch {
    return NextResponse.json({ error: "Merchant stores could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const originError = sameOriginRequired(request);
  if (originError) return originError;
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;
  if (authorization.context.role !== "MERCHANT_ADMIN") {
    return NextResponse.json({ error: "A demo merchant administrator must create stores." }, { status: 403 });
  }
  const rateLimit = checkMerchantMutationLimit(authorization.context.userId, "store-create", 10);
  if (!rateLimit.allowed) return merchantRateLimitResponse("store-create", rateLimit.retryAfterSeconds);

  let body: unknown;
  try {
    body = await readJsonLimited(request, MAX_REQUEST_BYTES);
  } catch (error) {
    const tooLarge = error instanceof RequestReadError && error.status === 413;
    return NextResponse.json({ error: tooLarge ? "Request body is too large." : "Request body must be valid JSON." }, { status: tooLarge ? 413 : 400 });
  }
  const parsed = createMerchantStoreSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Store details are invalid." }, { status: 400 });

  try {
    const db = getDb();
    const { merchantId, userId } = authorization.context;
    let created: Awaited<ReturnType<typeof db.store.create>> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const slug = buildStoreSlug(parsed.data.name, parsed.data.city, randomUUID());
      try {
        created = await db.$transaction(async (tx) => {
          const store = await tx.store.create({
            data: {
              merchantId,
              slug,
              name: parsed.data.name,
              city: parsed.data.city,
              timezone: parsed.data.timezone,
              pickupAddress: parsed.data.pickupAddress,
              currency: "USD",
              isDemo: true,
            },
          });
          await tx.auditEvent.create({
            data: {
              actorUserId: userId,
              actorType: "MERCHANT",
              action: "DEMO_STORE_CREATED",
              entityType: "Store",
              entityId: store.id,
              metadata: { slug: store.slug, currency: "USD" },
            },
          });
          return store;
        }, { isolationLevel: "Serializable" });
        break;
      } catch (error) {
        if (!isUniqueConstraint(error) || attempt === 2) throw error;
      }
    }
    if (!created) return NextResponse.json({ error: "Store could not be created." }, { status: 503 });
    return NextResponse.json({ store: serializeStore(created) }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Store could not be created." }, { status: 503 });
  }
}

function serializeStore(store: {
  id: string;
  slug: string;
  name: string;
  city: string;
  timezone: string;
  pickupAddress: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    city: store.city,
    timezone: store.timezone,
    pickupAddress: store.pickupAddress,
    currency: "USD",
    isDemo: true,
    createdAt: store.createdAt.toISOString(),
    updatedAt: store.updatedAt.toISOString(),
  };
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

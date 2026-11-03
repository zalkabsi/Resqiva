import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { authorizeDemoMerchant, sameOriginRequired } from "@/lib/merchant-auth";

export const runtime = "nodejs";

const updateSchema = z.object({
  quantityOnHand: z.number().int().min(0).max(10_000).optional(),
  discountedPriceCents: z.number().int().min(1).max(1_000_000).optional(),
  originalPriceCents: z.number().int().min(1).max(1_000_000).optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  sellable: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide at least one inventory field to update.");

type RouteContext = { params: Promise<{ lotId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const originError = sameOriginRequired(request);
  if (originError) return originError;
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;

  const { lotId } = await context.params;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(lotId)) {
    return NextResponse.json({ error: "Inventory reference is invalid." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Inventory changes are invalid." }, { status: 400 });

  try {
    const db = getDb();
    const { merchantId, userId } = authorization.context;
    const lot = await db.inventoryLot.findFirst({
      where: { id: lotId, store: { merchantId, isDemo: true }, product: { isDemo: true } },
      select: {
        id: true,
        storeId: true,
        quantityOnHand: true,
        quantityReserved: true,
        quantitySold: true,
        discountedPriceCents: true,
        originalPriceCents: true,
        expiresAt: true,
        sellable: true,
      },
    });
    if (!lot) return NextResponse.json({ error: "Inventory listing was not found for this demo merchant." }, { status: 404 });

    const nextQuantity = parsed.data.quantityOnHand ?? lot.quantityOnHand;
    const nextDiscount = parsed.data.discountedPriceCents ?? lot.discountedPriceCents;
    const nextOriginal = parsed.data.originalPriceCents ?? lot.originalPriceCents;
    if (nextQuantity < lot.quantityReserved + lot.quantitySold) {
      return NextResponse.json({ error: "Quantity cannot be lower than units already reserved or sold." }, { status: 409 });
    }
    if (nextDiscount > nextOriginal) {
      return NextResponse.json({ error: "The discounted price cannot exceed the original price." }, { status: 400 });
    }

    let nextExpiresAt = lot.expiresAt;
    if (parsed.data.expiresAt !== undefined) {
      if (parsed.data.expiresAt === null) nextExpiresAt = null;
      else {
        const candidate = new Date(`${parsed.data.expiresAt}T23:59:59.999Z`);
        if (!Number.isFinite(candidate.getTime()) || candidate.toISOString().slice(0, 10) !== parsed.data.expiresAt) {
          return NextResponse.json({ error: "Expiry date must be a real calendar date in YYYY-MM-DD format." }, { status: 400 });
        }
        nextExpiresAt = candidate;
      }
    }
    if (parsed.data.sellable === true && (!nextExpiresAt || nextExpiresAt < new Date())) {
      return NextResponse.json({ error: "A listing must have a future, recorded expiry date before it can be sellable." }, { status: 400 });
    }
    const sellable = parsed.data.sellable
      ?? (parsed.data.expiresAt === null ? false : lot.sellable);
    if (sellable && nextExpiresAt && nextExpiresAt < new Date()) {
      return NextResponse.json({ error: "Expired inventory cannot be marked sellable." }, { status: 400 });
    }

    const updated = await db.$transaction(async (tx) => {
      const result = await tx.inventoryLot.updateMany({
        where: {
          id: lot.id,
          store: { merchantId, isDemo: true },
          quantityOnHand: lot.quantityOnHand,
          quantityReserved: lot.quantityReserved,
          quantitySold: lot.quantitySold,
        },
        data: {
          quantityOnHand: nextQuantity,
          discountedPriceCents: nextDiscount,
          originalPriceCents: nextOriginal,
          expiresAt: nextExpiresAt,
          sellable,
        },
      });
      if (result.count !== 1) return null;
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          actorType: "MERCHANT",
          action: "DEMO_INVENTORY_UPDATED",
          entityType: "InventoryLot",
          entityId: lot.id,
          metadata: {
            quantityOnHand: nextQuantity,
            discountedPriceCents: nextDiscount,
            originalPriceCents: nextOriginal,
            sellable,
          },
        },
      });
      return tx.inventoryLot.findUnique({
        where: { id: lot.id },
        select: {
          id: true,
          quantityOnHand: true,
          quantityReserved: true,
          quantitySold: true,
          discountedPriceCents: true,
          originalPriceCents: true,
          expiresAt: true,
          sellable: true,
        },
      });
    }, { isolationLevel: "Serializable" });

    if (!updated) return NextResponse.json({ error: "Inventory changed during this edit. Refresh and retry." }, { status: 409 });
    return NextResponse.json({
      inventory: {
        ...updated,
        quantityAvailable: Math.max(0, updated.quantityOnHand - updated.quantityReserved - updated.quantitySold),
        expiresAt: updated.expiresAt?.toISOString() ?? null,
      },
    });
  } catch {
    return NextResponse.json({ error: "Inventory update could not be saved." }, { status: 503 });
  }
}

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authorizeDemoMerchant } from "@/lib/merchant-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;

  try {
    const db = getDb();
    const { merchantId } = authorization.context;
    const [stores, paidTotals, paidUnits] = await Promise.all([db.store.findMany({
      where: { merchantId, isDemo: true },
      select: {
        id: true,
        name: true,
        inventoryLots: {
          where: { sellable: true },
          orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            quantityOnHand: true,
            quantityReserved: true,
            quantitySold: true,
            discountedPriceCents: true,
            originalPriceCents: true,
            expiresAt: true,
            product: { select: { name: true, sku: true, allergenDataStatus: true } },
          },
        },
        orders: {
          orderBy: { createdAt: "desc" },
          take: 100,
          include: {
            user: { select: { displayName: true } },
            pickupWindow: { select: { startsAt: true, endsAt: true } },
            items: {
              select: {
                productNameSnapshot: true,
                quantity: true,
                unitPriceCents: true,
              },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    }),
    db.order.aggregate({
      where: { store: { merchantId, isDemo: true }, status: { in: ["PAID", "FULFILLED"] } },
      _sum: { amountCents: true },
    }),
    db.orderItem.aggregate({
      where: { order: { store: { merchantId, isDemo: true }, status: { in: ["PAID", "FULFILLED"] } } },
      _sum: { quantity: true },
    })]);

    const orders = stores.flatMap((store) => store.orders.map((order) => ({
      id: order.id,
      pickupReference: order.id.slice(-8).toUpperCase(),
      status: order.status,
      paymentStatus: order.paymentStatus,
      amountCents: order.amountCents,
      createdAt: order.createdAt.toISOString(),
      pickupStart: order.pickupWindow.startsAt.toISOString(),
      pickupEnd: order.pickupWindow.endsAt.toISOString(),
      buyerName: order.user?.displayName ?? "Demo Shopper",
      storeName: store.name,
      items: order.items.map((item) => ({
        productName: item.productNameSnapshot,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents,
      })),
    }))).sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    const inventory = stores.flatMap((store) => store.inventoryLots.map((lot) => ({
      id: lot.id,
      name: lot.product.name,
      sku: lot.product.sku,
      quantityAvailable: Math.max(0, lot.quantityOnHand - lot.quantityReserved - lot.quantitySold),
      quantityReserved: lot.quantityReserved,
      quantitySold: lot.quantitySold,
      priceCents: lot.discountedPriceCents,
      originalPriceCents: lot.originalPriceCents,
      expiresAt: lot.expiresAt?.toISOString() ?? null,
      allergenDataStatus: lot.product.allergenDataStatus,
    })));

    const analytics = {
      activeListings: inventory.filter((item) => item.quantityAvailable > 0).length,
      unitsRescued: paidUnits._sum.quantity ?? 0,
      revenueCents: paidTotals._sum.amountCents ?? 0,
    };

    return NextResponse.json({ orders, inventory, analytics });
  } catch {
    return NextResponse.json({ error: "Merchant data could not be loaded." }, { status: 503 });
  }
}

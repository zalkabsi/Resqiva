import { NextResponse } from "next/server";
import { readSessionFromRequest } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = readSessionFromRequest(request);
  if (!session || session.role !== "CUSTOMER") {
    return NextResponse.json(
      { error: "A signed customer demo session is required." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const orders = await getDb().order.findMany({
      where: { userId: session.userId, user: { isDemo: true } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        currency: true,
        amountCents: true,
        createdAt: true,
        paidAt: true,
        fulfilledAt: true,
        store: { select: { name: true } },
        pickupWindow: { select: { startsAt: true, endsAt: true } },
        items: {
          select: {
            productNameSnapshot: true,
            quantity: true,
            unitPriceCents: true,
            originalUnitPriceCents: true,
          },
        },
      },
    });

    return NextResponse.json({
      orders: orders.map((order) => ({
        id: order.id,
        pickupReference: order.id.slice(-8).toUpperCase(),
        status: order.status,
        paymentStatus: order.paymentStatus,
        currency: order.currency,
        amountCents: order.amountCents,
        createdAt: order.createdAt.toISOString(),
        paidAt: order.paidAt?.toISOString() ?? null,
        fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
        storeName: order.store.name,
        pickupStart: order.pickupWindow.startsAt.toISOString(),
        pickupEnd: order.pickupWindow.endsAt.toISOString(),
        items: order.items.map((item) => ({
          productName: item.productNameSnapshot,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          originalUnitPriceCents: item.originalUnitPriceCents,
        })),
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Order history could not be loaded." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

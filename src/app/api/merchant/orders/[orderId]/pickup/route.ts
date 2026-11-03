import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { authorizeDemoMerchant, sameOriginRequired } from "@/lib/merchant-auth";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ orderId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const originError = sameOriginRequired(request);
  if (originError) return originError;
  const authorization = await authorizeDemoMerchant(request);
  if (!authorization.ok) return authorization.response;

  const { orderId } = await context.params;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(orderId)) {
    return NextResponse.json({ error: "Order reference is invalid." }, { status: 400 });
  }

  try {
    const db = getDb();
    const { userId, merchantId } = authorization.context;
    const result = await db.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, store: { merchantId, isDemo: true } },
        select: { id: true, status: true, paymentStatus: true, reservationId: true, fulfilledAt: true },
      });
      if (!order) return { kind: "missing" as const };
      if (order.status === "FULFILLED") return { kind: "fulfilled" as const, fulfilledAt: order.fulfilledAt };
      if (order.status !== "PAID" || order.paymentStatus !== "CAPTURED") return { kind: "not_paid" as const };
      const reservation = await tx.reservation.findUnique({ where: { id: order.reservationId }, select: { status: true } });
      if (!reservation || reservation.status !== "PAID") return { kind: "reservation_state" as const };

      const now = new Date();
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: "PAID", paymentStatus: "CAPTURED" },
        data: { status: "FULFILLED", fulfilledAt: now },
      });
      if (updated.count !== 1) return { kind: "raced" as const };

      const reservationUpdate = await tx.reservation.updateMany({
        where: { id: order.reservationId, status: "PAID" },
        data: { status: "FULFILLED" },
      });
      if (reservationUpdate.count !== 1) return { kind: "raced" as const };
      await tx.auditEvent.create({
        data: {
          actorUserId: userId,
          actorType: "MERCHANT",
          action: "ORDER_PICKUP_CONFIRMED",
          entityType: "Order",
          entityId: order.id,
          metadata: { status: "FULFILLED" },
        },
      });
      return { kind: "fulfilled" as const, fulfilledAt: now };
    }, { isolationLevel: "Serializable" });

    if (result.kind === "missing") return NextResponse.json({ error: "Order was not found for this demo merchant." }, { status: 404 });
    if (result.kind === "not_paid") return NextResponse.json({ error: "Only a captured, paid order can be marked as picked up." }, { status: 409 });
    if (result.kind === "reservation_state") return NextResponse.json({ error: "The reservation state does not match the captured order. Reconcile it before pickup." }, { status: 409 });
    if (result.kind === "raced") return NextResponse.json({ error: "Order status changed. Refresh the merchant queue and try again." }, { status: 409 });
    return NextResponse.json({ status: "FULFILLED", fulfilledAt: result.fulfilledAt?.toISOString() ?? new Date().toISOString() });
  } catch {
    return NextResponse.json({ error: "Pickup confirmation could not be saved." }, { status: 503 });
  }
}

import { NextResponse } from "next/server";
import { isSameOriginMutation, readSessionFromRequest } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ReservationError, releaseReservation } from "@/lib/reservations";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ reservationId: string }> },
) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not accepted." }, { status: 403 });
  }
  const session = readSessionFromRequest(request);
  if (!session || session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "A demo shopper session is required to cancel this reservation." }, { status: 401 });
  }
  const { reservationId } = await context.params;
  if (!reservationId || reservationId.length > 128) {
    return NextResponse.json({ error: "A valid reservation reference is required." }, { status: 400 });
  }

  try {
    const db = getDb();
    const reservation = await db.reservation.findUnique({
      where: { id: reservationId },
      select: { id: true, userId: true, status: true },
    });
    if (!reservation || reservation.userId !== session.userId) {
      return NextResponse.json({ error: "The reservation could not be found." }, { status: 404 });
    }
    const released = await releaseReservation(reservationId, "CANCELLED", session.userId);
    if (released === "not_releasable") {
      return NextResponse.json({
        error: "The payment state could not be confirmed as unpaid, so stock remains held while the order is reconciled. Do not retry checkout.",
        status: reservation.status,
      }, { status: 409 });
    }
    return NextResponse.json({ status: "CANCELLED", released: released === "released" });
  } catch (error) {
    if (error instanceof ReservationError && error.code === "RESERVATION_NOT_FOUND") {
      return NextResponse.json({ error: "The reservation could not be found." }, { status: 404 });
    }
    return NextResponse.json({ error: "The reservation could not be safely cancelled. Check the order status before retrying." }, { status: 503 });
  }
}

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { expireStaleReservations } from "@/lib/reservations";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = getDb();
    const now = new Date();
    await expireStaleReservations();
    const stores = await db.store.findMany({
      where: { isDemo: true },
      include: {
        merchant: { select: { name: true } },
        pickupWindows: {
          where: { active: true, endsAt: { gt: now } },
          orderBy: { startsAt: "asc" },
        },
        inventoryLots: {
          where: { sellable: true, expiresAt: { gt: now } },
          include: { product: { select: { isActive: true } } },
        },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json({
      stores: stores.map((store) => {
        const pickup = store.pickupWindows.find((window) => window.startsAt > now);
        const availableUnits = store.inventoryLots
          .filter((lot) => lot.product.isActive)
          .reduce((sum, lot) => sum + Math.max(0, lot.quantityOnHand - lot.quantityReserved - lot.quantitySold), 0);
        return {
          id: store.id,
          name: store.name,
          merchantName: store.merchant.name,
          neighborhood: "Fictional demo location",
          location: store.city,
          pickupAddress: store.pickupAddress,
          itemCount: availableUnits,
          pickupStart: pickup ? toZonedIso(pickup.startsAt, store.timezone) : undefined,
          pickupEnd: pickup ? toZonedIso(pickup.endsAt, store.timezone) : undefined,
          demo: true,
        };
      }),
    });
  } catch {
    return NextResponse.json(
      { error: "Demo store data is temporarily unavailable. Check the database setup and retry." },
      { status: 503 },
    );
  }
}

function toZonedIso(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "00";
  const rawOffset = part("timeZoneName");
  const offset = rawOffset === "GMT" ? "Z" : rawOffset.replace(/^GMT/, "");
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${offset}`;
}

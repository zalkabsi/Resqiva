import { NextResponse } from "next/server";
import { z } from "zod";
import { createSessionToken, isSameOriginMutation, sessionCookie } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

const bodySchema = z.object({ role: z.enum(["CUSTOMER", "MERCHANT_ADMIN"]) }).strict();

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: { code: "origin_rejected", message: "This request must come from the Resqiva site." } }, { status: 403 });
  }
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_DEMO_LOGIN !== "true") {
    return NextResponse.json({ error: { code: "demo_login_disabled", message: "Demo access is not enabled." } }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: { code: "invalid_request", message: "Choose a demo workspace." } }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "invalid_request", message: "Choose a shopper or merchant demo workspace." } }, { status: 400 });
  }

  try {
    const db = getDb();
    if (parsed.data.role === "CUSTOMER") {
      const user = await db.user.findFirst({
        where: { email: "shopper@demo.resqiva.invalid", isDemo: true, role: "CUSTOMER" },
        select: { id: true, displayName: true, role: true },
      });
      if (!user) return unavailable();
      const token = createSessionToken({ userId: user.id, role: "CUSTOMER" });
      return NextResponse.json(
        { user: { displayName: user.displayName, role: user.role } },
        { headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } },
      );
    }

    const membership = await db.merchantMember.findFirst({
      where: { user: { isDemo: true, role: "MERCHANT_ADMIN" }, merchant: { isDemo: true, slug: "fictional-green-basket" } },
      include: { user: { select: { id: true, displayName: true, role: true } }, merchant: { select: { id: true, name: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (!membership) return unavailable();
    const token = createSessionToken({ userId: membership.user.id, role: "MERCHANT_ADMIN", merchantId: membership.merchantId });
    return NextResponse.json(
      { user: { displayName: membership.user.displayName, role: membership.user.role }, merchant: { name: membership.merchant.name } },
      { headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: { code: "session_unavailable", message: "The demo session could not be created. Check the local database and session configuration." } }, { status: 503 });
  }
}

function unavailable() {
  return NextResponse.json({ error: { code: "demo_data_missing", message: "Demo data is not available yet. Run the database seed step first." } }, { status: 503 });
}

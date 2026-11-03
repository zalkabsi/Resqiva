import "server-only";
import { NextResponse } from "next/server";
import { readSessionFromRequest, type ResqivaSession } from "@/lib/auth";
import { getDb } from "@/lib/db";

export type MerchantContext = {
  userId: string;
  merchantId: string;
  role: "MERCHANT_ADMIN" | "MERCHANT_STAFF";
};

export type MerchantAuthorization =
  | { ok: true; context: MerchantContext }
  | { ok: false; response: NextResponse };

export async function authorizeDemoMerchant(request: Request): Promise<MerchantAuthorization> {
  let session: ResqivaSession | null;
  try {
    session = readSessionFromRequest(request);
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Demo merchant sessions are not configured." }, { status: 503 }),
    };
  }
  if (!session || !session.merchantId || !["MERCHANT_ADMIN", "MERCHANT_STAFF"].includes(session.role)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Sign in to the fictional demo merchant workspace." }, { status: 401 }),
    };
  }

  try {
    const db = getDb();
    const membership = await db.merchantMember.findFirst({
      where: {
        userId: session.userId,
        merchantId: session.merchantId,
        role: { in: ["MERCHANT_ADMIN", "MERCHANT_STAFF"] },
      },
      select: {
        role: true,
        user: { select: { isDemo: true } },
        merchant: { select: { id: true, isDemo: true } },
      },
    });

    if (!membership || !membership.user.isDemo || !membership.merchant.isDemo) {
      return {
        ok: false,
        response: NextResponse.json({ error: "This demo session is not authorized for that merchant." }, { status: 403 }),
      };
    }

    return {
      ok: true,
      context: {
        userId: session.userId,
        merchantId: membership.merchant.id,
        role: membership.role as MerchantContext["role"],
      },
    };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Merchant authorization is temporarily unavailable." }, { status: 503 }),
    };
  }
}

export function sameOriginRequired(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    return process.env.NODE_ENV === "production"
      ? NextResponse.json({ error: "Origin verification is required for this request." }, { status: 403 })
      : null;
  }
  try {
    return new URL(origin).origin === new URL(request.url).origin
      ? null
      : NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  } catch {
    return NextResponse.json({ error: "Origin verification failed." }, { status: 403 });
  }
}

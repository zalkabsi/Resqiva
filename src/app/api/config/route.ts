import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(
    {
      paypalClientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ?? process.env.PAYPAL_CLIENT_ID ?? null,
      demoLoginEnabled: process.env.NODE_ENV !== "production" || process.env.ENABLE_DEMO_LOGIN === "true",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

import { NextResponse } from "next/server";
import { clearedSessionCookie, isSameOriginMutation } from "@/lib/auth";

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: { code: "origin_rejected", message: "This request must come from the Resqiva site." } }, { status: 403 });
  }
  return NextResponse.json({ ok: true }, { headers: { "Set-Cookie": clearedSessionCookie(), "Cache-Control": "no-store" } });
}

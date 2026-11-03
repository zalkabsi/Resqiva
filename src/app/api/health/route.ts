import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ status: "ok", service: "resqiva", mode: process.env.NODE_ENV ?? "unknown" });
}

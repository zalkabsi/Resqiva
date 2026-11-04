import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  try {
    await getDb().$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", service: "resqiva", mode: process.env.NODE_ENV ?? "unknown" });
  } catch {
    return NextResponse.json({ status: "unavailable", service: "resqiva" }, { status: 503 });
  }
}

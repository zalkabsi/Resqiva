import { NextResponse } from "next/server";
import { z } from "zod";
import { isSameOriginMutation, readSessionFromRequest } from "@/lib/auth";
import { ReservationError, createReservationForBundle } from "@/lib/reservations";

export const runtime = "nodejs";

const reservationRequestSchema = z.object({ bundleId: z.string().min(1).max(128) }).strict();

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Cross-origin requests are not accepted." }, { status: 403 });
  }
  const session = readSessionFromRequest(request);
  if (!session || session.role !== "CUSTOMER") {
    return NextResponse.json({ error: "Start a demo shopper session to reserve a meal set." }, { status: 401 });
  }
  const body = await readBoundedJson(request, 4 * 1024);
  if (!body.ok) return NextResponse.json({ error: body.message }, { status: body.status });
  const input = reservationRequestSchema.safeParse(body.value);
  if (!input.success) return NextResponse.json({ error: "A valid meal set reference is required." }, { status: 400 });

  try {
    const reservation = await createReservationForBundle(input.data.bundleId, session.userId);
    return NextResponse.json({
      reservationId: reservation.id,
      status: reservation.status,
      expiresAt: reservation.expiresAt.toISOString(),
    }, { status: 201 });
  } catch (error) {
    if (error instanceof ReservationError) {
      const status = error.code === "BUNDLE_NOT_FOUND" ? 404 : 409;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "The reservation could not be created. Refresh the plan and try again." }, { status: 503 });
  }
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: number; message: string }
> {
  if (!request.body) return { ok: false, status: 400, message: "Request body is required." };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, message: "Request body is too large." };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, message: "Request body could not be read." };
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400, message: "Request body must be valid JSON." };
  }
}

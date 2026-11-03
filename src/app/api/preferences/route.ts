import { NextResponse } from "next/server";
import { parsePreferences, PreferenceParserError, preferenceRequestSchema } from "@/lib/ai";
import { checkRateLimit, requestRateLimitKey } from "@/lib/rate-limit";
import { readJsonLimited, RequestReadError } from "@/lib/request";

export const runtime = "nodejs";
export const maxDuration = 20;

export async function POST(request: Request) {
  const limit = checkRateLimit(requestRateLimitKey(request), 12, 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: { code: "rate_limited", message: "Too many planning requests. Please wait a moment and try again." } },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await readJsonLimited(request, 4_096);
  } catch (error) {
    if (error instanceof RequestReadError) {
      return NextResponse.json({ error: { code: "invalid_request", message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ error: { code: "invalid_request", message: "Request body must be valid JSON." } }, { status: 400 });
  }

  const input = preferenceRequestSchema.safeParse(body);
  if (!input.success) {
    return NextResponse.json(
      { error: { code: "invalid_request", message: "Provide a meal request of 3 to 1,500 characters." } },
      { status: 400 },
    );
  }

  try {
    const preferences = await parsePreferences(input.data.prompt, input.data.selectedStoreId);
    return NextResponse.json({ preferences });
  } catch (error) {
    if (error instanceof PreferenceParserError) {
      const status = error.code === "invalid_request" ? 400 : error.code === "misconfigured" ? 503 : error.code === "provider_unavailable" ? 502 : 422;
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return NextResponse.json(
      { error: { code: "preference_error", message: "The request could not be parsed. Please try again." } },
      { status: 500 },
    );
  }
}

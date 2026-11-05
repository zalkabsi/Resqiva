import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "resqiva_demo_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 2;

export type SessionRole = "CUSTOMER" | "MERCHANT_ADMIN" | "MERCHANT_STAFF";

export interface ResqivaSession {
  userId: string;
  role: SessionRole;
  merchantId?: string;
  expiresAt: number;
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes.");
  }
  return secret;
}

function sign(value: string): Buffer {
  return createHmac("sha256", sessionSecret()).update(value).digest();
}

export function createSessionToken(
  input: Omit<ResqivaSession, "expiresAt">,
  now = Date.now(),
): string {
  const session: ResqivaSession = { ...input, expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000 };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = sign(payload).toString("base64url");
  return `${payload}.${signature}`;
}

export function readSessionToken(token: string | undefined, now = Date.now()): ResqivaSession | null {
  if (!token || token.length > 2048) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const encodedSignature = token.slice(separator + 1);
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  let expected: Buffer;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isSession(parsed) || parsed.expiresAt <= now) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readSessionFromRequest(request: Request): ResqivaSession | null {
  const header = request.headers.get("cookie") ?? "";
  const cookie = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return readSessionToken(cookie?.slice(SESSION_COOKIE.length + 1));
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return process.env.NODE_ENV !== "production";
  try {
    const parsed = new URL(origin);
    const externalHostname = process.env.RENDER_EXTERNAL_HOSTNAME;
    // Render terminates TLS at its edge, so request.url can use http internally
    // even when the browser reached the service over https.
    const expectedOrigin = externalHostname
      ? new URL(`https://${externalHostname}`).origin
      : new URL(request.url).origin;
    return parsed.origin === expectedOrigin;
  } catch {
    return false;
  }
}

function isSession(value: unknown): value is ResqivaSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  return typeof session.userId === "string"
    && session.userId.length > 0
    && (session.role === "CUSTOMER" || session.role === "MERCHANT_ADMIN" || session.role === "MERCHANT_STAFF")
    && (session.merchantId === undefined || typeof session.merchantId === "string")
    && typeof session.expiresAt === "number"
    && Number.isSafeInteger(session.expiresAt);
}

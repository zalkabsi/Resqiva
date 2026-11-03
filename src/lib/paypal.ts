const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";
const PAYPAL_CURRENCY = "USD" as const;

export type PayPalOrderStatus =
  | "CREATED"
  | "SAVED"
  | "APPROVED"
  | "VOIDED"
  | "COMPLETED"
  | "PAYER_ACTION_REQUIRED"
  | (string & {});

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalOrder {
  id: string;
  status: PayPalOrderStatus;
  links?: PayPalLink[];
  purchase_units?: Array<Record<string, unknown>>;
}

export interface PayPalCapture extends PayPalOrder {
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id?: string;
        status?: string;
        amount?: { currency_code?: string; value?: string };
        [key: string]: unknown;
      }>;
    };
    [key: string]: unknown;
  }>;
}

/**
 * A server-side reservation that has already been repriced from trusted
 * inventory records. Never construct this object from browser-supplied totals.
 */
export interface ReservedCheckout {
  reservationId: string;
  trustedTotalCents: number;
  status: "RESERVED";
}

export interface CreatePayPalOrderInput {
  reservation: ReservedCheckout;
  idempotencyKey: string;
  returnUrl: string;
  cancelUrl: string;
}

export class PayPalApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly debugId?: string;

  constructor(status: number, code?: string, debugId?: string) {
    const safeCode = code && /^[A-Z0-9_]{1,80}$/i.test(code) ? code : undefined;
    super(`PayPal Sandbox request failed (${status})${safeCode ? `: ${safeCode}` : ""}`);
    this.name = "PayPalApiError";
    this.status = status;
    this.code = safeCode;
    this.debugId = debugId && /^[A-Za-z0-9-]{1,100}$/.test(debugId) ? debugId : undefined;
  }
}

function readCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("PayPal Sandbox credentials are not configured on the server.");
  }
  return { clientId, clientSecret };
}

function getFetch(fetcher?: typeof fetch): typeof fetch {
  return fetcher ?? globalThis.fetch;
}

function paypalRequestId(value: string): string {
  if (!/^[A-Za-z0-9:_-]{1,108}$/.test(value)) {
    throw new Error("Invalid PayPal idempotency key.");
  }
  return value;
}

function paypalOrderId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Invalid PayPal order ID.");
  }
  return encodeURIComponent(value);
}

function redirectUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PayPal return and cancel URLs must be valid absolute URLs.");
  }
  const isLocalHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!isLocalHttp && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("PayPal return and cancel URLs must use HTTPS (HTTP is allowed for localhost only).");
  }
  return url.toString();
}

/** Format exact integer minor units without floating-point arithmetic. */
export function centsToPayPalAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error("PayPal amount must be a positive safe integer number of cents.");
  }
  const whole = Math.floor(cents / 100).toString();
  const fraction = (cents % 100).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

async function getAccessToken(fetcher: typeof fetch): Promise<string> {
  const { clientId, clientSecret } = readCredentials();
  const authorization = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const response = await fetcher(`${PAYPAL_SANDBOX_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });

  const payload = await readJson(response);
  if (!response.ok) {
    throw providerError(response.status, payload);
  }
  if (!isRecord(payload) || typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("PayPal Sandbox OAuth returned an invalid response.");
  }
  return payload.access_token;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return {};
    throw new Error("PayPal Sandbox returned an invalid JSON response.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerError(status: number, payload: unknown): PayPalApiError {
  if (!isRecord(payload)) return new PayPalApiError(status);
  const codeCandidate = typeof payload.name === "string"
    ? payload.name
    : typeof payload.error === "string"
      ? payload.error
      : undefined;
  const debugId = typeof payload.debug_id === "string" ? payload.debug_id : undefined;
  return new PayPalApiError(status, codeCandidate, debugId);
}

async function paypalJson<T>(
  path: string,
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<T> {
  const accessToken = await getAccessToken(fetcher);
  const response = await fetcher(`${PAYPAL_SANDBOX_BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  });
  const payload = await readJson(response);
  if (!response.ok) throw providerError(response.status, payload);
  return payload as T;
}

function validateOrder(payload: unknown): PayPalOrder {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.status !== "string") {
    throw new Error("PayPal Sandbox returned an invalid order response.");
  }
  return payload as unknown as PayPalOrder;
}

/**
 * Creates a Sandbox order from a server-calculated, active reservation.
 * The browser must submit only the reservation ID to its application route.
 */
export async function createPayPalOrder(
  input: CreatePayPalOrderInput,
  fetcher?: typeof fetch,
): Promise<PayPalOrder> {
  const { reservation } = input;
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(reservation.reservationId) ||
    reservation.status !== "RESERVED"
  ) {
    throw new Error("Only an active reservation can be sent to PayPal Checkout.");
  }
  const value = centsToPayPalAmount(reservation.trustedTotalCents);
  const requestId = paypalRequestId(input.idempotencyKey);
  const returnUrl = redirectUrl(input.returnUrl);
  const cancelUrl = redirectUrl(input.cancelUrl);

  const payload = await paypalJson<unknown>(
    "/v2/checkout/orders",
    {
      method: "POST",
      headers: { "PayPal-Request-Id": requestId },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: reservation.reservationId,
            amount: { currency_code: PAYPAL_CURRENCY, value },
          },
        ],
        application_context: {
          return_url: returnUrl,
          cancel_url: cancelUrl,
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      }),
    },
    getFetch(fetcher),
  );
  return validateOrder(payload);
}

/** Capture a buyer-approved Sandbox order. Check the returned status server-side. */
export async function capturePayPalOrder(
  orderId: string,
  idempotencyKey: string,
  fetcher?: typeof fetch,
): Promise<PayPalCapture> {
  const id = paypalOrderId(orderId);
  const requestId = paypalRequestId(idempotencyKey);
  const payload = await paypalJson<unknown>(
    `/v2/checkout/orders/${id}/capture`,
    {
      method: "POST",
      headers: { "PayPal-Request-Id": requestId },
      body: "{}",
    },
    getFetch(fetcher),
  );
  return validateOrder(payload) as PayPalCapture;
}

/** Fetch PayPal's authoritative order state for reconciliation. */
export async function getPayPalOrder(
  orderId: string,
  fetcher?: typeof fetch,
): Promise<PayPalOrder> {
  const id = paypalOrderId(orderId);
  const payload = await paypalJson<unknown>(`/v2/checkout/orders/${id}`, { method: "GET" }, getFetch(fetcher));
  return validateOrder(payload);
}

export interface PayPalWebhookHeaders {
  authAlgo: string | null;
  certUrl: string | null;
  transmissionId: string | null;
  transmissionSig: string | null;
  transmissionTime: string | null;
}

export function paypalWebhookHeaders(headers: Headers): PayPalWebhookHeaders {
  return {
    authAlgo: headers.get("paypal-auth-algo"),
    certUrl: headers.get("paypal-cert-url"),
    transmissionId: headers.get("paypal-transmission-id"),
    transmissionSig: headers.get("paypal-transmission-sig"),
    transmissionTime: headers.get("paypal-transmission-time"),
  };
}

/** Verify a webhook with PayPal before processing or persisting its event. */
export async function verifyPayPalWebhookSignature(
  headers: PayPalWebhookHeaders,
  event: unknown,
  fetcher?: typeof fetch,
): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID?.trim();
  if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is required to verify PayPal webhooks.");
  if (
    !headers.authAlgo ||
    !headers.certUrl ||
    !headers.transmissionId ||
    !headers.transmissionSig ||
    !headers.transmissionTime ||
    !isRecord(event)
  ) {
    return false;
  }
  const payload = await paypalJson<{ verification_status?: unknown }>(
    "/v1/notifications/verify-webhook-signature",
    {
      method: "POST",
      body: JSON.stringify({
        auth_algo: headers.authAlgo,
        cert_url: headers.certUrl,
        transmission_id: headers.transmissionId,
        transmission_sig: headers.transmissionSig,
        transmission_time: headers.transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      }),
    },
    getFetch(fetcher),
  );
  return payload?.verification_status === "SUCCESS";
}

export function paypalApprovalUrl(order: PayPalOrder): string | undefined {
  const link = order.links?.find((candidate) => candidate.rel === "approve" || candidate.rel === "payer-action");
  if (!link) return undefined;
  try {
    const url = new URL(link.href);
    if (url.protocol !== "https:" || url.hostname !== "www.sandbox.paypal.com") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

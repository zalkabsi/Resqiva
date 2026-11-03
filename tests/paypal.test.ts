import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PayPalApiError,
  capturePayPalOrder,
  centsToPayPalAmount,
  createPayPalOrder,
  getPayPalOrder,
  paypalApprovalUrl,
  verifyPayPalWebhookSignature,
} from "../src/lib/paypal";

type RecordedCall = { input: RequestInfo | URL; init?: RequestInit };

function mockFetch(responses: Response[], calls: RecordedCall[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected fetch call in test.");
    return response;
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const oauthSuccess = () => json({ access_token: "test-access-token", token_type: "Bearer", expires_in: 900 });

beforeEach(() => {
  process.env.PAYPAL_CLIENT_ID = "test-client-id";
  process.env.PAYPAL_CLIENT_SECRET = "test";
  delete process.env.PAYPAL_WEBHOOK_ID;
});

describe("PayPal Sandbox client", () => {
  it("formats integer cents exactly", () => {
    expect(centsToPayPalAmount(1)).toBe("0.01");
    expect(centsToPayPalAmount(105)).toBe("1.05");
    expect(centsToPayPalAmount(12_345)).toBe("123.45");
    expect(() => centsToPayPalAmount(0)).toThrow(/positive safe integer/);
    expect(() => centsToPayPalAmount(1.5)).toThrow(/positive safe integer/);
    expect(() => centsToPayPalAmount(Number.MAX_SAFE_INTEGER + 1)).toThrow(/positive safe integer/);
  });

  it("creates a Sandbox order using only the server-calculated reservation total", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = mockFetch([
      oauthSuccess(),
      json({
        id: "SANDBOX-ORDER-1",
        status: "CREATED",
        links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=SANDBOX-ORDER-1" }],
      }),
    ], calls);

    const order = await createPayPalOrder({
      reservation: { reservationId: "reservation_123", trustedTotalCents: 1_099, status: "RESERVED" },
      idempotencyKey: "reservation_123:create",
      returnUrl: "http://localhost:3000/checkout/return",
      cancelUrl: "http://localhost:3000/checkout/cancel",
    }, fetcher);

    expect(order.id).toBe("SANDBOX-ORDER-1");
    expect(String(calls[0]?.input)).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(String(calls[1]?.input)).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect((calls[1]?.init?.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("reservation_123:create");
    const request = JSON.parse(String(calls[1]?.init?.body)) as {
      intent: string;
      purchase_units: Array<{ amount: { currency_code: string; value: string } }>;
    };
    expect(request.intent).toBe("CAPTURE");
    expect(request.purchase_units[0]?.amount).toEqual({ currency_code: "USD", value: "10.99" });
    expect(String(calls[1]?.input)).not.toContain("paypal.com/v2/checkout/orders/");
  });

  it("does not call PayPal for an invalid or unreserved checkout", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(createPayPalOrder({
      reservation: { reservationId: "r1", trustedTotalCents: 100, status: "PENDING" } as unknown as {
        reservationId: string;
        trustedTotalCents: number;
        status: "RESERVED";
      },
      idempotencyKey: "r1:create",
      returnUrl: "https://example.test/return",
      cancelUrl: "https://example.test/cancel",
    }, fetcher)).rejects.toThrow(/active reservation/);
    await expect(createPayPalOrder({
      reservation: { reservationId: "r1", trustedTotalCents: 1.2, status: "RESERVED" },
      idempotencyKey: "r1:create",
      returnUrl: "https://example.test/return",
      cancelUrl: "https://example.test/cancel",
    }, fetcher)).rejects.toThrow(/positive safe integer/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires HTTPS redirects except for localhost development", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(createPayPalOrder({
      reservation: { reservationId: "r1", trustedTotalCents: 100, status: "RESERVED" },
      idempotencyKey: "r1:create",
      returnUrl: "http://example.test/return",
      cancelUrl: "https://example.test/cancel",
    }, fetcher)).rejects.toThrow(/must use HTTPS/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("captures with a required idempotency key and returns the provider status", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = mockFetch([
      oauthSuccess(),
      json({
        id: "SANDBOX-ORDER-2",
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED" }] } }],
      }),
    ], calls);

    const capture = await capturePayPalOrder("SANDBOX-ORDER-2", "reservation_9:capture", fetcher);
    expect(capture.status).toBe("COMPLETED");
    expect(String(calls[1]?.input)).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/SANDBOX-ORDER-2/capture");
    expect((calls[1]?.init?.headers as Record<string, string>)["PayPal-Request-Id"]).toBe("reservation_9:capture");
  });

  it("queries the Sandbox order for reconciliation", async () => {
    const calls: RecordedCall[] = [];
    const fetcher = mockFetch([oauthSuccess(), json({ id: "ORDER_3", status: "APPROVED" })], calls);
    const order = await getPayPalOrder("ORDER_3", fetcher);
    expect(order.status).toBe("APPROVED");
    expect(String(calls[1]?.input)).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER_3");
    expect(calls[1]?.init?.method).toBe("GET");
  });

  it("requires a registered webhook ID and verifies using PayPal's verification endpoint", async () => {
    const headers = {
      authAlgo: "SHA256withRSA",
      certUrl: "https://api-m.sandbox.paypal.com/cert/test",
      transmissionId: "transmission-1",
      transmissionSig: "signature",
      transmissionTime: "2026-11-03T12:00:00Z",
    };
    const event = { id: "WH-1", event_type: "CHECKOUT.ORDER.APPROVED" };
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(verifyPayPalWebhookSignature(headers, event, fetcher)).rejects.toThrow(/PAYPAL_WEBHOOK_ID is required/);
    expect(fetcher).not.toHaveBeenCalled();

    process.env.PAYPAL_WEBHOOK_ID = "test-hook";
    const calls: RecordedCall[] = [];
    const validFetcher = mockFetch([oauthSuccess(), json({ verification_status: "SUCCESS" })], calls);
    await expect(verifyPayPalWebhookSignature(headers, event, validFetcher)).resolves.toBe(true);
    expect(String(calls[1]?.input)).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    const body = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(body.webhook_id).toBe("test-hook");
    expect(body.webhook_event).toEqual(event);
  });

  it("returns false for incomplete webhook headers or non-success verification", async () => {
    process.env.PAYPAL_WEBHOOK_ID = "test-hook";
    const event = { id: "WH-2" };
    const fetcher = vi.fn() as unknown as typeof fetch;
    const incomplete = await verifyPayPalWebhookSignature({
      authAlgo: null,
      certUrl: null,
      transmissionId: null,
      transmissionSig: null,
      transmissionTime: null,
    }, event, fetcher);
    expect(incomplete).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();

    const failedFetcher = mockFetch([oauthSuccess(), json({ verification_status: "FAILURE" })]);
    await expect(verifyPayPalWebhookSignature({
      authAlgo: "SHA256withRSA",
      certUrl: "https://api-m.sandbox.paypal.com/cert/test",
      transmissionId: "transmission-2",
      transmissionSig: "signature",
      transmissionTime: "2026-11-03T12:00:00Z",
    }, event, failedFetcher)).resolves.toBe(false);
  });

  it("sanitizes provider errors instead of returning raw response messages", async () => {
    const fetcher = mockFetch([json({ name: "invalid_client", message: "do not surface this response text" }, 401)]);
    await expect(getPayPalOrder("ORDER_4", fetcher)).rejects.toMatchObject({
      name: "PayPalApiError",
      status: 401,
      code: "invalid_client",
    } satisfies Partial<PayPalApiError>);
    await expect(getPayPalOrder("ORDER_5", mockFetch([
      json({ name: "invalid_client", message: "do not surface this response text" }, 401),
    ]))).rejects.not.toThrow("do not surface this response text");
  });

  it("accepts only the Sandbox PayPal approval URL", () => {
    expect(paypalApprovalUrl({
      id: "ORDER_6",
      status: "CREATED",
      links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER_6" }],
    })).toContain("www.sandbox.paypal.com");
    expect(paypalApprovalUrl({
      id: "ORDER_7",
      status: "CREATED",
      links: [{ rel: "approve", href: "https://evil.example/checkout" }],
    })).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/paypal", () => ({
  getPayPalOrder: vi.fn(),
  paypalWebhookHeaders: vi.fn(),
  verifyPayPalWebhookSignature: vi.fn(),
}));
vi.mock("@/app/api/paypal/_lib/finalize", () => ({
  finalizeCapturedPayment: vi.fn(),
  flagPaymentException: vi.fn(),
}));
vi.mock("@/app/api/paypal/_lib/capture-validation", () => ({ verifyCompletedCapture: vi.fn() }));

import { POST } from "@/app/api/paypal/webhook/route";

describe("POST /api/paypal/webhook request size", () => {
  beforeEach(() => {
    delete process.env.PAYPAL_WEBHOOK_ID;
  });

  afterEach(() => {
    delete process.env.PAYPAL_WEBHOOK_ID;
  });

  it("rejects a body larger than one megabyte", async () => {
    const response = await POST(new Request("http://localhost/api/paypal/webhook", {
      method: "POST",
      body: " ".repeat(1_000_001),
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Webhook body exceeds the allowed size." });
  });

  it("accepts exactly one megabyte through bounded reading before checking configuration", async () => {
    const event = JSON.stringify({ id: "WH-BOUNDARY", event_type: "TEST.EVENT" });
    const body = `${event}${" ".repeat(1_000_000 - new TextEncoder().encode(event).byteLength)}`;
    expect(new TextEncoder().encode(body).byteLength).toBe(1_000_000);

    const response = await POST(new Request("http://localhost/api/paypal/webhook", {
      method: "POST",
      body,
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "PayPal webhook verification is not configured." });
  });
});

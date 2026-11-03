import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePreferences,
  PreferenceParserError,
  preferenceOutputSchema,
  RESQIVA_AI_MODEL,
} from "@/lib/ai";

const validOutput = {
  budgetCents: 2_500,
  servings: 3,
  mealCount: 2,
  exclusions: ["vegetarian"],
  allergies: ["peanuts"],
  preferredIngredients: ["lentils"],
  avoidIngredients: ["mushrooms"],
  pickupDate: "2026-11-03",
};

function completion(body: unknown, model: string = RESQIVA_AI_MODEL): Response {
  return new Response(
    JSON.stringify({ model, choices: [{ message: { role: "assistant", content: JSON.stringify(body) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function setRequiredEnv() {
  vi.stubEnv("AI_PROVIDER", "fireworks");
  vi.stubEnv("AI_MODEL", RESQIVA_AI_MODEL);
  vi.stubEnv("FIREWORKS_API_KEY", "test-key-not-a-real-secret");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("preference output validation", () => {
  it("accepts valid preference-only output", () => {
    expect(preferenceOutputSchema.safeParse(validOutput).success).toBe(true);
  });

  it("rejects invented financial or inventory fields", () => {
    expect(preferenceOutputSchema.safeParse({ ...validOutput, totalCents: 100 }).success).toBe(false);
    expect(preferenceOutputSchema.safeParse({ ...validOutput, productIds: ["invented"] }).success).toBe(false);
  });

  it("rejects impossible dates and unsafe numeric boundaries", () => {
    expect(preferenceOutputSchema.safeParse({ ...validOutput, pickupDate: "2026-02-30" }).success).toBe(false);
    expect(preferenceOutputSchema.safeParse({ ...validOutput, servings: 0 }).success).toBe(false);
    expect(preferenceOutputSchema.safeParse({ ...validOutput, budgetCents: 0 }).success).toBe(false);
    expect(preferenceOutputSchema.safeParse({ ...validOutput, budgetCents: 100_001 }).success).toBe(false);
  });
});

describe("parsePreferences", () => {
  it("calls only the configured Fireworks model and preserves source/store on the server", async () => {
    setRequiredEnv();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      void _url;
      void _init;
      return completion(validOutput);
    });

    const parsed = await parsePreferences(
      "Two vegetarian dinners for three people under $25 without peanuts, pickup today.",
      "store-demo-1",
      { fetchImpl: fetchMock, currentDate: "2026-11-03" },
    );

    expect(parsed).toEqual({ ...validOutput, storeId: "store-demo-1", sourceText: "Two vegetarian dinners for three people under $25 without peanuts, pickup today." });
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(String(init.body));
    expect(sent.model).toBe(RESQIVA_AI_MODEL);
    expect(sent.messages[0].content).toContain("untrusted preference data");
    expect(sent.messages[1].content).toBe("Two vegetarian dinners for three people under $25 without peanuts, pickup today.");
    expect(sent.messages[1].content).not.toContain("store-demo-1");
  });

  it("fails closed on a mismatched model or provider without making a request", async () => {
    vi.stubEnv("AI_PROVIDER", "other-provider");
    vi.stubEnv("AI_MODEL", RESQIVA_AI_MODEL);
    vi.stubEnv("FIREWORKS_API_KEY", "test-key-not-a-real-secret");
    const fetchMock = vi.fn<typeof fetch>();

    await expect(parsePreferences("A dinner for two", undefined, { fetchImpl: fetchMock })).rejects.toMatchObject({ code: "misconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("AI_PROVIDER", "fireworks");
    vi.stubEnv("AI_MODEL", "unexpected-model-for-negative-test");
    await expect(parsePreferences("A dinner for two", undefined, { fetchImpl: fetchMock })).rejects.toMatchObject({ code: "misconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a provider response identifying a different model", async () => {
    setRequiredEnv();
    const fetchMock = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return completion(validOutput, "unexpected-model-for-negative-test");
    });

    await expect(parsePreferences("A dinner for two", undefined, { fetchImpl: fetchMock })).rejects.toMatchObject({ code: "invalid_model_output" });
  });

  it("does not silently substitute when the provider is unavailable", async () => {
    setRequiredEnv();
    const fetchMock = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response("", { status: 503 });
    });

    await expect(parsePreferences("A dinner for two", undefined, { fetchImpl: fetchMock })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects malformed and schema-invalid model output", async () => {
    setRequiredEnv();
    const malformedFetch = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(JSON.stringify({ model: RESQIVA_AI_MODEL, choices: [{ message: { content: "not json" } }] }), { status: 200 });
    });
    await expect(parsePreferences("A dinner for two", undefined, { fetchImpl: malformedFetch })).rejects.toMatchObject({ code: "invalid_model_output" });

    const invalidFetch = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return completion({ ...validOutput, productIds: ["nonexistent"] });
    });
    await expect(parsePreferences("A dinner for two", undefined, { fetchImpl: invalidFetch })).rejects.toMatchObject({ code: "invalid_model_output" });
  });

  it("rejects a past pickup date even when it is a valid calendar date", async () => {
    setRequiredEnv();
    const fetchMock = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return completion({ ...validOutput, pickupDate: "2026-11-02" });
    });

    await expect(
      parsePreferences("A dinner for two", undefined, { fetchImpl: fetchMock, currentDate: "2026-11-03" }),
    ).rejects.toMatchObject({ code: "invalid_model_output" });
  });

  it("validates request input before calling the model", async () => {
    setRequiredEnv();
    const fetchMock = vi.fn<typeof fetch>();
    await expect(parsePreferences(" x ", undefined, { fetchImpl: fetchMock })).rejects.toBeInstanceOf(PreferenceParserError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

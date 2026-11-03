import { describe, expect, it } from "vitest";
import { readJsonLimited, readTextLimited, RequestReadError } from "@/lib/request";

function post(body: BodyInit, headers?: HeadersInit): Request {
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, headers, duplex: "half" };
  return new Request("http://localhost/test", init);
}

describe("bounded request body readers", () => {
  it("accepts JSON at the byte limit and counts UTF-8 bytes rather than characters", async () => {
    const body = JSON.stringify({ preference: "é" });
    const request = post(body);

    await expect(readJsonLimited(request, new TextEncoder().encode(body).byteLength)).resolves.toEqual({ preference: "é" });
  });

  it("rejects an oversized declared length before reading the body", async () => {
    await expect(readTextLimited(post("{}", { "content-length": "100" }), 10)).rejects.toMatchObject({
      name: "RequestReadError",
      status: 413,
      message: "Request body is too large.",
    });
  });

  it("rejects an oversized streamed body even when no content length is supplied", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"));
        controller.enqueue(new TextEncoder().encode("456"));
        controller.close();
      },
    });

    await expect(readTextLimited(post(stream), 5)).rejects.toMatchObject({
      name: "RequestReadError",
      status: 413,
    });
  });

  it("reports missing and malformed bodies as client errors", async () => {
    const missing = new Request("http://localhost/test", { method: "POST" });
    await expect(readTextLimited(missing, 10)).rejects.toMatchObject({ status: 400 });

    await expect(readJsonLimited(post("{"), 10)).rejects.toBeInstanceOf(RequestReadError);
    await expect(readJsonLimited(post("{"), 10)).rejects.toMatchObject({
      status: 400,
      message: "Request body must be valid JSON.",
    });
  });
});

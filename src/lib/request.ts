export class RequestReadError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
    this.name = "RequestReadError";
  }
}

/** Read bounded JSON without buffering an untrusted, arbitrarily large body. */
export async function readJsonLimited(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RequestReadError(413, "Request body is too large.");
  }
  if (!request.body) throw new RequestReadError(400, "Request body is required.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestReadError(413, "Request body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestReadError) throw error;
    throw new RequestReadError(400, "Request body could not be read.");
  }

  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new RequestReadError(400, "Request body must be valid JSON.");
  }
}

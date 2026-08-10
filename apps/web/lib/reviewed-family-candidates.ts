import {
  reviewedFamilyCandidateInspectionRequestSchema,
  reviewedFamilyCandidateInspectionResponseSchemaFor,
  type ReviewedFamilyCandidateInspectionRequest,
  type ReviewedFamilyCandidateInspectionResponse,
} from "@handleplan/domain";

const MAX_RESPONSE_BYTES = 128 * 1024;

export type ReviewedFamilyCandidateInspection = (
  request: ReviewedFamilyCandidateInspectionRequest,
  signal: AbortSignal,
) => Promise<ReviewedFamilyCandidateInspectionResponse>;

export type ReviewedFamilyCandidateClientErrorCode =
  | "CANCELLED"
  | "NO_CANDIDATES"
  | "STALE_OR_AMBIGUOUS"
  | "UNAVAILABLE"
  | "INVALID_RESPONSE";

export class ReviewedFamilyCandidateClientError extends Error {
  constructor(readonly code: ReviewedFamilyCandidateClientErrorCode) {
    super(code);
    this.name = "ReviewedFamilyCandidateClientError";
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Best-effort cleanup only.
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;.*)?$/i.test(contentType)) {
    await cancelBody(response.body);
    throw new ReviewedFamilyCandidateClientError("INVALID_RESPONSE");
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_RESPONSE_BYTES
  ) {
    await cancelBody(response.body);
    throw new ReviewedFamilyCandidateClientError("INVALID_RESPONSE");
  }
  if (response.body === null) {
    throw new ReviewedFamilyCandidateClientError("INVALID_RESPONSE");
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new ReviewedFamilyCandidateClientError("INVALID_RESPONSE");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fragments: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ReviewedFamilyCandidateClientError("INVALID_RESPONSE");
      }
      fragments.push(decoder.decode(value, { stream: true }));
    }
    fragments.push(decoder.decode());
    return JSON.parse(fragments.join("")) as unknown;
  } catch (error) {
    try { await reader.cancel(); } catch { /* Cleanup only. */ }
    if (error instanceof ReviewedFamilyCandidateClientError) throw error;
    throw new ReviewedFamilyCandidateClientError("INVALID_RESPONSE");
  }
}

function codeForStatus(status: number): ReviewedFamilyCandidateClientErrorCode {
  if (status === 499) return "CANCELLED";
  if (status === 409) return "STALE_OR_AMBIGUOUS";
  if (status === 422) return "NO_CANDIDATES";
  return "UNAVAILABLE";
}

export const inspectReviewedFamilyCandidates: ReviewedFamilyCandidateInspection = async (
  input,
  signal,
) => {
  const request = reviewedFamilyCandidateInspectionRequestSchema.parse(input);
  let response: Response;
  try {
    response = await fetch("/api/plan-candidates", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    });
  } catch (error) {
    if (
      signal.aborted
      || (error instanceof DOMException && error.name === "AbortError")
    ) {
      throw new ReviewedFamilyCandidateClientError("CANCELLED");
    }
    throw new ReviewedFamilyCandidateClientError("UNAVAILABLE");
  }
  if (!response.ok) {
    await cancelBody(response.body);
    throw new ReviewedFamilyCandidateClientError(codeForStatus(response.status));
  }

  const parsed = reviewedFamilyCandidateInspectionResponseSchemaFor(request).safeParse(
    await readBoundedJson(response),
  );
  if (!parsed.success) {
    throw new ReviewedFamilyCandidateClientError("INVALID_RESPONSE");
  }
  return parsed.data;
};

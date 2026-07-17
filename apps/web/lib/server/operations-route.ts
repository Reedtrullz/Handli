import "server-only";

import {
  readOperationsAccessConfig,
  verifyOperationsAccess,
  type OperationsPrincipal,
} from "./operations-access";
import { OperationsRuntimeServiceError } from "./operations-runtime-service";

const PRIVATE_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
});

export type OperationsAuthenticator = (request: Request) => Promise<OperationsPrincipal>;

export const defaultOperationsAuthenticator: OperationsAuthenticator = async (request) =>
  verifyOperationsAccess(request, readOperationsAccessConfig());

export function operationsPrivateJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { headers: PRIVATE_HEADERS, status });
}
export function operationsPrivateError(code: string, status: number): Response {
  return operationsPrivateJson({ code }, status);
}

export function operationsPrivateNotFound(): Response {
  return operationsPrivateError("NOT_FOUND", 404);
}

export function operationsPrivateBoundedJson(value: unknown, maximumBytes: number): Response {
  try {
    const body = JSON.stringify(value);
    if (new TextEncoder().encode(body).byteLength > maximumBytes) {
      return operationsPrivateError("RESPONSE_TOO_LARGE", 503);
    }
    return new Response(body, { headers: PRIVATE_HEADERS });
  } catch {
    return operationsPrivateError("OPERATIONS_UNAVAILABLE", 503);
  }
}

export async function authorizePrivateOperations(
  request: Request,
  authenticate: OperationsAuthenticator,
): Promise<OperationsPrincipal | undefined> {
  try {
    return await authenticate(request);
  } catch {
    return undefined;
  }
}

export function operationsServiceErrorResponse(error: unknown): Response {
  if (!(error instanceof OperationsRuntimeServiceError)) {
    return operationsPrivateError("OPERATIONS_UNAVAILABLE", 503);
  }
  return error.code === "CANCELLED"
    ? operationsPrivateError("REQUEST_CANCELLED", 499)
    : operationsPrivateError("OPERATIONS_UNAVAILABLE", 503);
}

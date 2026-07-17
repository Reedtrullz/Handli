import { type NextRequest, NextResponse } from "next/server";

import {
  readReviewAccessConfig,
  verifyReviewAccess,
} from "./lib/server/review-access";
import {
  readOperationsAccessConfig,
  verifyOperationsAccess,
} from "./lib/server/operations-access";

const PRIVATE_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
});

const PRIVATE_NOT_FOUND_HEADERS = Object.freeze({
  ...PRIVATE_HEADERS,
  "content-language": "nb",
  "content-type": "text/html; charset=utf-8",
});

const PRIVATE_NOT_FOUND_DOCUMENT = `<!doctype html>
<html lang="nb">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Siden finnes ikke | Handleplan</title>
  </head>
  <body>
    <main>
      <h1>Siden finnes ikke</h1>
      <p>Kontroller adressen og prøv igjen.</p>
    </main>
  </body>
</html>`;

/**
 * Authenticate the private page against the actual inbound URL. API routes keep
 * their own auth-first checks so this boundary cannot move authorization behind
 * query/body parsing or database resolution.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  try {
    if (
      request.nextUrl.pathname === "/internal/operations"
      || request.nextUrl.pathname.startsWith("/internal/operations/")
    ) {
      await verifyOperationsAccess(request, readOperationsAccessConfig());
    } else {
      await verifyReviewAccess(request, readReviewAccessConfig());
    }
  } catch {
    return new NextResponse(PRIVATE_NOT_FOUND_DOCUMENT, {
      headers: PRIVATE_NOT_FOUND_HEADERS,
      status: 404,
    });
  }

  const response = NextResponse.next();
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: ["/review/:path*", "/internal/operations/:path*"],
};

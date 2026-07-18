import "server-only";

import { z } from "zod";

import {
  verifyReviewAccess,
  type ReviewAccessConfig,
} from "./review-access";

const teamDomainSchema = z.url().transform((value) => new URL(value)).refine((url) =>
  url.protocol === "https:"
  && url.username === ""
  && url.password === ""
  && url.port === ""
  && url.pathname === "/"
  && url.search === ""
  && url.hash === ""
  && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u
    .test(url.hostname), {
    message: "Operations Access team domain must be a fixed Cloudflare Access HTTPS origin",
  }).transform((url) => url.origin);

const baseUrlSchema = z.url().transform((value) => new URL(value)).refine((url) =>
  url.protocol === "https:"
  && url.username === ""
  && url.password === ""
  && url.pathname === "/"
  && url.search === ""
  && url.hash === "", {
    message: "Operations base URL must be a fixed HTTPS origin",
  }).transform((url) => url.origin);

const operationsAccessEnvSchema = z.object({
  OPERATIONS_ACCESS_AUDIENCE: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/u),
  OPERATIONS_ACCESS_ISSUER: teamDomainSchema,
  OPERATIONS_ACCESS_TEAM_DOMAIN: teamDomainSchema,
  OPERATIONS_BASE_URL: baseUrlSchema,
}).strict().superRefine((value, context) => {
  if (value.OPERATIONS_ACCESS_ISSUER !== value.OPERATIONS_ACCESS_TEAM_DOMAIN) {
    context.addIssue({
      code: "custom",
      message: "Operations Access issuer must equal the configured team domain",
      path: ["OPERATIONS_ACCESS_ISSUER"],
    });
  }
});

export type OperationsAccessConfig = ReviewAccessConfig;

export interface OperationsPrincipal {
  actorId: string;
  expiresAt: string;
}

export class OperationsAccessDeniedError extends Error {
  constructor() {
    super("Private operations access denied");
    this.name = "OperationsAccessDeniedError";
  }
}

const OPERATIONS_REQUEST_PATHS = new Set([
  "/api/internal/operations/snapshot",
  "/api/internal/operations/snapshot/",
  "/internal/operations",
  "/internal/operations/",
]);

function denied(): never {
  throw new OperationsAccessDeniedError();
}

function assertOperationsRequestUrl(request: Request, config: OperationsAccessConfig): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    denied();
  }
  if (
    url.origin !== config.baseUrl
    || !OPERATIONS_REQUEST_PATHS.has(url.pathname)
  ) denied();
}

export function readOperationsAccessConfig(
  values: Record<string, string | undefined> = process.env,
): OperationsAccessConfig {
  const parsed = operationsAccessEnvSchema.parse({
    OPERATIONS_ACCESS_AUDIENCE: values.OPERATIONS_ACCESS_AUDIENCE,
    OPERATIONS_ACCESS_ISSUER: values.OPERATIONS_ACCESS_ISSUER,
    OPERATIONS_ACCESS_TEAM_DOMAIN: values.OPERATIONS_ACCESS_TEAM_DOMAIN,
    OPERATIONS_BASE_URL: values.OPERATIONS_BASE_URL,
  });
  return Object.freeze({
    audience: parsed.OPERATIONS_ACCESS_AUDIENCE,
    baseUrl: parsed.OPERATIONS_BASE_URL,
    issuer: parsed.OPERATIONS_ACCESS_ISSUER,
    jwksUrl: `${parsed.OPERATIONS_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
    teamDomain: parsed.OPERATIONS_ACCESS_TEAM_DOMAIN,
  });
}

/**
 * Reuses only the hardened RS256/JWKS verifier. The operations request is
 * first bound to its own exact path/origin and uses an independently named
 * audience/config. No review credential or review route is accepted.
 */
export async function verifyOperationsAccess(
  request: Request,
  config: OperationsAccessConfig,
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<OperationsPrincipal> {
  assertOperationsRequestUrl(request, config);
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (assertion === null) denied();
  try {
    return await verifyReviewAccess(new Request(`${config.baseUrl}/review`, {
      headers: { "cf-access-jwt-assertion": assertion },
      method: "GET",
    }), config, options);
  } catch {
    denied();
  }
}

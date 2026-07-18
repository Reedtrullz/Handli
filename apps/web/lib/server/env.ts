import "server-only";

import { z } from "zod";

const realServerEnvSchema = z.object({
  DATABASE_URL: z
    .url()
    .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), {
      message: "DATABASE_URL must use postgres:// or postgresql://",
    }),
});

export type ServerEnv =
  | { mode: "fake" }
  | { mode: "real"; DATABASE_URL: string };

const browserEvidenceSentinelPattern = /^handleplan-e2e-[0-9a-f]{48}$/u;
const browserEvidenceRuntimeProofKey = Symbol.for(
  "handleplan.e2e.loopback-production-browser-fake-runtime.v1",
);

function browserEvidenceRuntimeProof(): unknown {
  return Reflect.get(globalThis, browserEvidenceRuntimeProofKey);
}

export function allowsLoopbackProductionBrowserFake(
  values: Record<string, string | undefined> = process.env,
): boolean {
  const sentinel = values.HANDLEPLAN_E2E_SENTINEL;
  return values.NODE_ENV === "production"
    && values.HANDLEPLAN_MODE === "fake"
    && typeof sentinel === "string"
    && browserEvidenceSentinelPattern.test(sentinel)
    && values.HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN === sentinel
    && values.KASSAL_API_KEY === sentinel
    && values.HANDLEPLAN_E2E_PUBLIC_ORIGIN === "https://127.0.0.1:3109"
    && values.HOSTNAME === "127.0.0.1"
    && values.PORT === "3108"
    && browserEvidenceRuntimeProof() === sentinel;
}

export function readServerEnv(
  values: Record<string, string | undefined> = process.env,
): ServerEnv {
  if (values.HANDLEPLAN_MODE === "fake") {
    if (values.NODE_ENV === "production" && !allowsLoopbackProductionBrowserFake(values)) {
      throw new Error("HANDLEPLAN_MODE=fake is disabled in production");
    }
    if (values.NODE_ENV !== "production" && !["development", "test"].includes(values.NODE_ENV ?? "")) {
      throw new Error("HANDLEPLAN_MODE=fake is limited to development and test runtimes");
    }
    return { mode: "fake" };
  }
  if (values.HANDLEPLAN_MODE !== undefined && values.HANDLEPLAN_MODE !== "real") {
    throw new Error("HANDLEPLAN_MODE must be real or fake");
  }
  const parsed = realServerEnvSchema.parse(values);
  return { mode: "real", DATABASE_URL: parsed.DATABASE_URL };
}

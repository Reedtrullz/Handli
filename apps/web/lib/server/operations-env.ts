import "server-only";

import { createHash } from "node:crypto";

import {
  canonicalizeOperationsSourceRosterV1,
  operationsSourceRosterV1Schema,
  type OperationsAlertRuntimeConfigV1,
  type OperationsSourceRosterV1,
} from "@handleplan/domain";
import { z } from "zod";

const MAX_ROSTER_BYTES = 32 * 1024;

export type DisabledOperationsAlertRuntimeConfigV1 = Extract<
  OperationsAlertRuntimeConfigV1,
  { enabled: false }
>;

const operationsDatabaseUrlSchema = z.url().transform((value) => new URL(value))
  .refine((url) => ["postgres:", "postgresql:"].includes(url.protocol), {
    message: "OPERATIONS_DATABASE_URL must use PostgreSQL",
  })
  .refine((url) => url.username === "handleplan_operations", {
    message: "OPERATIONS_DATABASE_URL must use the least-privilege handleplan_operations role",
  })
  .refine((url) => url.password.length >= 32, {
    message: "OPERATIONS_DATABASE_URL requires a generated role password",
  })
  .transform((url) => url.toString());

export type OperationsServerEnv =
  | {
      alertRuntimeConfig: DisabledOperationsAlertRuntimeConfigV1;
      mode: "fake";
      sourceRoster: OperationsSourceRosterV1;
    }
  | {
      alertRuntimeConfig: DisabledOperationsAlertRuntimeConfigV1;
      mode: "real";
      OPERATIONS_DATABASE_URL: string;
      sourceRoster: OperationsSourceRosterV1;
    };

function parseAlertRuntimeConfig(
  enabledValue: string | undefined,
  encodedConfig: string | undefined,
): DisabledOperationsAlertRuntimeConfigV1 {
  const enabled = enabledValue ?? "false";
  if (enabled !== "false" && enabled !== "true") {
    throw new Error("OPERATIONS_ALERT_EVALUATION_ENABLED must be explicitly true or false");
  }
  if (enabled === "true") {
    throw new Error(
      "Operations alert evaluation cannot be enabled until its production scheduler is composed",
    );
  }
  if (encodedConfig !== undefined) {
    throw new Error("Disabled alert evaluation cannot carry activation capabilities");
  }
  return { contractVersion: 1, enabled: false };
}

function parseRoster(encoded: string | undefined): OperationsSourceRosterV1 {
  if (
    encoded === undefined
    || new TextEncoder().encode(encoded).byteLength > MAX_ROSTER_BYTES
  ) throw new Error("OPERATIONS_SOURCE_ROSTER_JSON is required and bounded");
  let raw: unknown;
  try {
    raw = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("OPERATIONS_SOURCE_ROSTER_JSON must be valid JSON");
  }
  const roster = operationsSourceRosterV1Schema.parse(raw);
  const digest = createHash("sha256").update(canonicalizeOperationsSourceRosterV1({
    entries: roster.entries,
    version: roster.version,
  }), "utf8").digest("hex");
  if (digest !== roster.contentSha256) {
    throw new Error("OPERATIONS_SOURCE_ROSTER_JSON digest does not match its canonical content");
  }
  return roster;
}

export function readOperationsServerEnv(
  values: Record<string, string | undefined> = process.env,
): OperationsServerEnv {
  const alertRuntimeConfig = parseAlertRuntimeConfig(
    values.OPERATIONS_ALERT_EVALUATION_ENABLED,
    values.OPERATIONS_ALERT_RUNTIME_CONFIG_JSON,
  );
  const sourceRoster = parseRoster(values.OPERATIONS_SOURCE_ROSTER_JSON);
  if (values.HANDLEPLAN_OPERATIONS_MODE === "fake") {
    if (values.NODE_ENV === "production") {
      throw new Error("HANDLEPLAN_OPERATIONS_MODE=fake is disabled in production");
    }
    return { alertRuntimeConfig, mode: "fake", sourceRoster };
  }
  if (
    values.HANDLEPLAN_OPERATIONS_MODE !== undefined
    && values.HANDLEPLAN_OPERATIONS_MODE !== "real"
  ) throw new Error("HANDLEPLAN_OPERATIONS_MODE must be real or fake");
  const databaseUrl = operationsDatabaseUrlSchema.parse(values.OPERATIONS_DATABASE_URL);
  return {
    alertRuntimeConfig,
    mode: "real",
    OPERATIONS_DATABASE_URL: databaseUrl,
    sourceRoster,
  };
}

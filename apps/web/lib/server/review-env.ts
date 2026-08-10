import "server-only";

import { isAbsolute, parse, resolve } from "node:path";

import { z } from "zod";

const reviewDatabaseUrlSchema = z
  .url()
  .transform((value) => new URL(value))
  .refine((url) => ["postgres:", "postgresql:"].includes(url.protocol), {
    message: "REVIEW_DATABASE_URL must use postgres:// or postgresql://",
  })
  .refine((url) => url.username === "handleplan_review", {
    message: "REVIEW_DATABASE_URL must use the least-privilege handleplan_review role",
  })
  .refine((url) => url.password.length >= 32, {
    message: "REVIEW_DATABASE_URL requires a non-empty generated role password",
  })
  .transform((url) => url.toString());

const realReviewEnvSchema = z.object({
  REVIEW_DATABASE_URL: reviewDatabaseUrlSchema,
  REVIEW_EVIDENCE_PROOF_SECRET: z.string()
    .regex(/^[A-Za-z0-9_-]{43,172}$/u)
    .refine((value) => {
      const bytes = Buffer.from(value, "base64url");
      return bytes.byteLength >= 32
        && bytes.byteLength <= 128
        && bytes.toString("base64url") === value;
    }, { message: "REVIEW_EVIDENCE_PROOF_SECRET must be canonical base64url with 32-128 bytes" }),
  REVIEW_PRIVATE_CAPTURE_ROOT: z.string().min(2).refine((value) =>
    !value.includes("\0")
    && isAbsolute(value)
    && resolve(value) === value
    && value !== parse(value).root, {
    message: "REVIEW_PRIVATE_CAPTURE_ROOT must be a normalized non-root absolute path",
  }),
}).strict();

export type ReviewServerEnv =
  | { mode: "fake" }
  | {
    mode: "real";
    REVIEW_DATABASE_URL: string;
    REVIEW_EVIDENCE_PROOF_SECRET: string;
    REVIEW_PRIVATE_CAPTURE_ROOT: string;
  };

export function readReviewServerEnv(
  values: Record<string, string | undefined> = process.env,
): ReviewServerEnv {
  if (values.HANDLEPLAN_REVIEW_MODE === "fake") {
    if (values.NODE_ENV === "production") {
      throw new Error("HANDLEPLAN_REVIEW_MODE=fake is disabled in production");
    }
    return { mode: "fake" };
  }
  if (
    values.HANDLEPLAN_REVIEW_MODE !== undefined
    && values.HANDLEPLAN_REVIEW_MODE !== "real"
  ) {
    throw new Error("HANDLEPLAN_REVIEW_MODE must be real or fake");
  }
  const parsed = realReviewEnvSchema.parse({
    REVIEW_DATABASE_URL: values.REVIEW_DATABASE_URL,
    REVIEW_EVIDENCE_PROOF_SECRET: values.REVIEW_EVIDENCE_PROOF_SECRET,
    REVIEW_PRIVATE_CAPTURE_ROOT: values.REVIEW_PRIVATE_CAPTURE_ROOT,
  });
  return {
    mode: "real",
    REVIEW_DATABASE_URL: parsed.REVIEW_DATABASE_URL,
    REVIEW_EVIDENCE_PROOF_SECRET: parsed.REVIEW_EVIDENCE_PROOF_SECRET,
    REVIEW_PRIVATE_CAPTURE_ROOT: parsed.REVIEW_PRIVATE_CAPTURE_ROOT,
  };
}

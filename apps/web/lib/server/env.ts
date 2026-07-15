import "server-only";

import { z } from "zod";

const realServerEnvSchema = z.object({
  KASSAL_MODE: z.literal("real").optional(),
  KASSAL_API_KEY: z.string().min(1),
  DATABASE_URL: z
    .url()
    .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol), {
      message: "DATABASE_URL must use postgres:// or postgresql://",
    }),
  KASSAL_BASE_URL: z.url().refine((value) => new URL(value).protocol === "https:", {
    message: "KASSAL_BASE_URL must use https://",
  }),
});

const fakeServerEnvSchema = z.object({
  KASSAL_MODE: z.literal("fake"),
});

export type ServerEnv =
  | { mode: "fake" }
  | {
      mode: "real";
      KASSAL_API_KEY: string;
      DATABASE_URL: string;
      KASSAL_BASE_URL: string;
    };

export function readServerEnv(
  values: Record<string, string | undefined> = process.env,
): ServerEnv {
  if (values.KASSAL_MODE === "fake") {
    fakeServerEnvSchema.parse(values);
    return { mode: "fake" };
  }
  if (values.KASSAL_MODE !== undefined && values.KASSAL_MODE !== "real") {
    throw new Error("KASSAL_MODE must be real or fake");
  }
  const parsed = realServerEnvSchema.parse(values);
  return {
    mode: "real",
    KASSAL_API_KEY: parsed.KASSAL_API_KEY,
    DATABASE_URL: parsed.DATABASE_URL,
    KASSAL_BASE_URL: parsed.KASSAL_BASE_URL,
  };
}

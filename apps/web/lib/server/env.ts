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

export function readServerEnv(
  values: Record<string, string | undefined> = process.env,
): ServerEnv {
  if (values.HANDLEPLAN_MODE === "fake") {
    if (values.NODE_ENV === "production") {
      throw new Error("HANDLEPLAN_MODE=fake is disabled in production");
    }
    return { mode: "fake" };
  }
  if (values.HANDLEPLAN_MODE !== undefined && values.HANDLEPLAN_MODE !== "real") {
    throw new Error("HANDLEPLAN_MODE must be real or fake");
  }
  const parsed = realServerEnvSchema.parse(values);
  return { mode: "real", DATABASE_URL: parsed.DATABASE_URL };
}

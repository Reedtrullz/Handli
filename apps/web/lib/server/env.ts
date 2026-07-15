import "server-only";

import { z } from "zod";

const serverEnvSchema = z.object({
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

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function readServerEnv(
  values: Record<string, string | undefined> = process.env,
): ServerEnv {
  return serverEnvSchema.parse(values);
}

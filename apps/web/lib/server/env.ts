import "server-only";

import { z } from "zod";

const serverEnvSchema = z.object({
  KASSAL_API_KEY: z.string().min(1),
  DATABASE_URL: z.url(),
  KASSAL_BASE_URL: z.url(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function readServerEnv(
  values: Record<string, string | undefined> = process.env,
): ServerEnv {
  return serverEnvSchema.parse(values);
}

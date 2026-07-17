import "server-only";

import { z } from "zod";

const readinessOutcomeSchema = z.enum(["ok", "unavailable"]);

export const operationalEventSchema = z.discriminatedUnion("event", [
  z.object({
    component: z.literal("postgresql"),
    contractVersion: z.literal(1),
    event: z.literal("dependency.readiness.checked"),
    outcome: readinessOutcomeSchema,
  }).strict(),
]);

export type OperationalEvent = z.infer<typeof operationalEventSchema>;
export type ReadinessOutcome = z.infer<typeof readinessOutcomeSchema>;

/**
 * The application boundary exposes one method per approved operational event.
 * It deliberately has no generic `log`, metadata, context, message, or error
 * argument through which request data or free text could enter telemetry.
 */
export interface OperationalEventLogger {
  dependencyReadinessChecked(outcome: ReadinessOutcome): undefined;
}

export type OperationalEventSink = (serializedEvent: string) => undefined;

export function createOperationalEventLogger(
  sink: OperationalEventSink,
): OperationalEventLogger {
  return Object.freeze({
    dependencyReadinessChecked(outcome: ReadinessOutcome): undefined {
      const event = operationalEventSchema.parse({
        component: "postgresql",
        contractVersion: 1,
        event: "dependency.readiness.checked",
        outcome,
      } satisfies OperationalEvent);
      sink(JSON.stringify(event));
      return undefined;
    },
  });
}

export const noopOperationalEventLogger: OperationalEventLogger = Object.freeze({
  dependencyReadinessChecked(): undefined {
    // Tests and explicitly silent boundaries may opt out of exporting events.
    return undefined;
  },
});

export const stdoutOperationalEventLogger = createOperationalEventLogger((line) => {
  process.stdout.write(`${line}\n`);
  return undefined;
});

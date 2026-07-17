import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createOperationalEventLogger,
  operationalEventSchema,
  type OperationalEventLogger,
} from "./operational-events";

const asyncExporterIsRejected: OperationalEventLogger = {
  // @ts-expect-error Exporters are deliberately synchronous so rejections cannot escape a route.
  async dependencyReadinessChecked() {
    return undefined;
  },
};
void asyncExporterIsRejected;

describe("allowlisted operational events", () => {
  it("emits only the fixed readiness event and enumerated outcome", () => {
    const lines: string[] = [];
    const logger = createOperationalEventLogger((line) => {
      lines.push(line);
      return undefined;
    });

    logger.dependencyReadinessChecked("ok");
    logger.dependencyReadinessChecked("unavailable");

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        component: "postgresql",
        contractVersion: 1,
        event: "dependency.readiness.checked",
        outcome: "ok",
      },
      {
        component: "postgresql",
        contractVersion: 1,
        event: "dependency.readiness.checked",
        outcome: "unavailable",
      },
    ]);
  });

  it.each([
    "basket",
    "query",
    "address",
    "latitude",
    "longitude",
    "coordinates",
    "ip",
    "userAgent",
    "message",
    "error",
    "metadata",
  ])("rejects the non-allowlisted field %s", (field) => {
    expect(operationalEventSchema.safeParse({
      component: "postgresql",
      contractVersion: 1,
      event: "dependency.readiness.checked",
      outcome: "ok",
      [field]: "forbidden-sentinel",
    }).success).toBe(false);
  });

  it("does not expose a generic free-text logging method", () => {
    const logger = createOperationalEventLogger(() => undefined);
    expect(Object.keys(logger)).toEqual(["dependencyReadinessChecked"]);
    expect("log" in logger).toBe(false);
    expect("event" in logger).toBe(false);
  });

  it("fails closed before the sink when an untyped caller supplies free text", () => {
    const lines: string[] = [];
    const logger = createOperationalEventLogger((line) => {
      lines.push(line);
      return undefined;
    });

    expect(() => {
      (logger.dependencyReadinessChecked as (outcome: string) => void)("private free text");
    }).toThrow();
    expect(lines).toEqual([]);
  });
});

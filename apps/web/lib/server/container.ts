import "server-only";

import { PostgresPriceCache } from "@handleplan/db";
import { createDatabase } from "@handleplan/db/client";
import { KassalappClient, type KassalappGateway } from "@handleplan/kassalapp";

import { readServerEnv } from "./env";
import { PlanService, type PlanServiceContract } from "./plan-service";

export interface ServerContainer {
  gateway: KassalappGateway;
  planService: PlanServiceContract;
}

let singleton: ServerContainer | undefined;

export function getServerContainer(): ServerContainer {
  if (singleton !== undefined) return singleton;

  const env = readServerEnv();
  const connection = createDatabase(env.DATABASE_URL);
  const gateway = new KassalappClient({
    apiKey: env.KASSAL_API_KEY,
    baseUrl: env.KASSAL_BASE_URL,
    fetch,
  });
  singleton = {
    gateway,
    planService: new PlanService({
      cache: new PostgresPriceCache(connection.db),
      gateway,
    }),
  };
  return singleton;
}

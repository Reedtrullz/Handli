import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type HandleplanDatabase = PostgresJsDatabase<typeof schema> & {
  $client: ReturnType<typeof postgres>;
};

export interface DatabaseConnection {
  db: HandleplanDatabase;
  sql: ReturnType<typeof postgres>;
  close(): Promise<void>;
}

export function createDatabase(databaseUrl: string): DatabaseConnection {
  const sql = postgres(databaseUrl, { max: 10 });

  return {
    db: drizzle(sql, { schema }),
    sql,
    close: () => sql.end(),
  };
}

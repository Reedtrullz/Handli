import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for migrations");

const migrationsDirectory = "/app/deploy/migrations";
const sql = postgres(databaseUrl, {
  connect_timeout: 10,
  idle_timeout: 5,
  max: 1,
  onnotice: () => {},
});

const advisoryLockId = 7_229_164_301;

try {
  await sql`select pg_advisory_lock(${advisoryLockId})`;
  await sql`
    create table if not exists handleplan_schema_migrations (
      id varchar(255) primary key,
      checksum char(64) not null,
      applied_at timestamptz not null default now()
    )
  `;

  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();

  for (const id of migrationFiles) {
    const source = await readFile(path.join(migrationsDirectory, id), "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const existing = await sql`
      select checksum from handleplan_schema_migrations where id = ${id}
    `;

    if (existing.length > 0) {
      if (existing[0].checksum !== checksum) {
        throw new Error(`Applied migration checksum changed: ${id}`);
      }
      continue;
    }

    await sql.begin(async (transaction) => {
      await transaction.unsafe(source);
      await transaction`
        insert into handleplan_schema_migrations (id, checksum)
        values (${id}, ${checksum})
      `;
    });
  }
} finally {
  await sql`select pg_advisory_unlock(${advisoryLockId})`.catch(() => undefined);
  await sql.end({ timeout: 5 });
}

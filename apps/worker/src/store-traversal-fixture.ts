import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createDatabase, type DatabaseConnection } from "@handleplan/db/client";

const execute = promisify(execFile);

export async function createTraversalFixture() {
  const names = ["DATABASE_URL", "APP_DATABASE_URL", "OPERATIONS_DATABASE_URL", "WEB_DATABASE_URL", "REVIEW_DATABASE_URL"] as const;
  const urls = names.map((name) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing traversal prerequisite: ${name}`);
    const url = new URL(value);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/handleplan") {
      throw new Error(`Traversal requires disposable loopback CI database: ${name}`);
    }
    return url;
  });
  const [adminUrl, appUrl, operationsUrl, webUrl, reviewUrl] = urls;
  if (!adminUrl || !appUrl || !operationsUrl || !webUrl || !reviewUrl) throw new Error("Missing role URLs");
  const control = createDatabase(adminUrl.toString());
  const database = `handleplan_traversal_${process.pid}`;
  const connections: DatabaseConnection[] = [];
  let created = false;
  const cleanup = async () => {
    await Promise.all(connections.map((connection) => connection.close()));
    if (created) {
      await control.sql.unsafe(`drop database "${database}" with (force)`);
      const survivors = await control.sql`select datname from pg_database where datname = ${database}`;
      if (survivors.length !== 0) throw new Error("Traversal database survived cleanup");
      console.info(JSON.stringify({ traversalQa: "cleanup", database, survivors: survivors.length }));
    }
    await control.close();
  };
  console.info(JSON.stringify({ traversalQa: "register", database, resources: ["migrated-database", "role-connections", "bounded-migration-child"] }));
  try {
    await control.sql.unsafe(`create database "${database}" template template0`);
    created = true;
    for (const url of urls) url.pathname = `/${database}`;
    const migration = fileURLToPath(new URL("../../../deploy/migrate.mjs", import.meta.url));
    const { stdout } = await execute(process.execPath, [migration], {
      env: { ...process.env, DATABASE_MIGRATION_URL: adminUrl.toString(),
        MIGRATIONS_DIR: fileURLToPath(new URL("../../../deploy/migrations", import.meta.url)),
        APP_DATABASE_PASSWORD: decodeURIComponent(appUrl.password),
        OPERATIONS_DATABASE_PASSWORD: decodeURIComponent(operationsUrl.password),
        WEB_DATABASE_PASSWORD: decodeURIComponent(webUrl.password),
        REVIEW_DATABASE_PASSWORD: decodeURIComponent(reviewUrl.password) },
      timeout: 45_000, maxBuffer: 512 * 1024,
    });
    console.info(JSON.stringify({ traversalQa: "migrated", database, stdout }));
    const connect = (url: URL) => {
      const connection = createDatabase(url.toString());
      connections.push(connection);
      return connection;
    };
    const admin = connect(adminUrl), app = connect(appUrl), operations = connect(operationsUrl), web = connect(webUrl);
    let previousClock = 0;
    const clock = async () => {
      // Round beyond persisted microseconds and keep scheduled slots strictly ordered.
      const [row] = await admin.sql<{ at: string }[]>`select ceil(extract(epoch from clock_timestamp()) * 1000)::text as at`;
      if (!row) throw new Error("Missing PostgreSQL clock");
      previousClock = Math.max(Number(row.at), previousClock + 1);
      return new Date(previousClock);
    };
    const permission = async (approved: boolean) => {
      const at = await clock();
      const reviewedAt = new Date(at.getTime() - 1_000).toISOString();
      const decision = approved ? "approved" : "revoked";
      await admin.sql`insert into source_permissions (source_id, decision, reviewed_at, permissions, notes)
        values ('kassalapp', ${decision}, ${reviewedAt}, '{"catalog":true,"ordinaryPrice":true}'::jsonb, 'authored traversal QA')`;
      await admin.sql`update data_sources set runtime_state = ${decision}, permission_reviewed_at = ${reviewedAt},
        permission_expires_at = null where id = 'kassalapp'`;
    };
    await permission(true);
    return { admin, app, operations, web, clock, permission, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

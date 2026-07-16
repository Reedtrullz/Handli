import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseConnection } from "./client";
import { PostgresSourceAccessReader } from "./source-access";

const runDatabaseIntegration = process.env.RUN_DB_INTEGRATION === "1";
const nonce = `${process.pid}-${Date.now()}`;
const sourceId = `policy-test-${nonce}`.slice(0, 64);

describe.skipIf(!runDatabaseIntegration).sequential(
  "PostgresSourceAccessReader integration",
  () => {
    let connection: DatabaseConnection;
    let reader: PostgresSourceAccessReader;

    beforeAll(async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required when RUN_DB_INTEGRATION=1");
      }
      connection = createDatabase(process.env.DATABASE_URL);
      reader = new PostgresSourceAccessReader(connection.db);
      await connection.sql`
        insert into data_sources (
          id, display_name, source_kind, runtime_state
        ) values (
          ${sourceId}, 'Source policy integration fixture', 'catalog', 'conditional'
        )
      `;
    });

    afterAll(async () => {
      // source_permissions is deliberately append-only. The CI database is ephemeral,
      // so this uniquely named fixture remains available as audit evidence until teardown.
      await connection?.close();
    });

    it("reads the fail-closed source default before any permission exists", async () => {
      await expect(reader.getSourceAccess(sourceId)).resolves.toEqual({
        permissionCurrent: false,
        permissions: {},
        runtimeState: "conditional",
        sourcePermissionCurrent: false,
      });
    });

    it("requires both current source metadata and the latest current approval", async () => {
      await connection.sql`
        update data_sources
        set
          runtime_state = 'approved',
          permission_reviewed_at = '2098-01-01T00:00:00Z',
          permission_expires_at = '2099-01-01T00:00:00Z'
        where id = ${sourceId}
      `;
      await connection.sql`
        insert into source_permissions (
          source_id,
          decision,
          reviewed_at,
          valid_until,
          permissions,
          notes
        ) values (
          ${sourceId},
          'approved',
          '2020-01-01T00:00:00Z',
          '2099-01-01T00:00:00Z',
          '{"catalog":true,"ordinaryPrice":true,"priceHistory":true,"physicalStore":false}'::jsonb,
          'source-access integration approval'
        )
      `;

      await expect(reader.getSourceAccess(sourceId)).resolves.toMatchObject({
        permissionCurrent: true,
        permissionDecision: "approved",
        sourcePermissionCurrent: false,
      });
      await connection.sql`
        update data_sources
        set permission_reviewed_at = '2020-01-01T00:00:00Z'
        where id = ${sourceId}
      `;

      await expect(reader.getSourceAccess(sourceId)).resolves.toEqual({
        permissionCurrent: true,
        permissionDecision: "approved",
        permissions: {
          catalog: true,
          ordinaryPrice: true,
          priceHistory: true,
          physicalStore: false,
        },
        runtimeState: "approved",
        sourcePermissionCurrent: true,
      });
    });

    it("uses the latest append-only decision and reports expiry from PostgreSQL time", async () => {
      await connection.sql`
        insert into source_permissions (
          source_id,
          decision,
          reviewed_at,
          valid_until,
          permissions,
          notes
        ) values (
          ${sourceId},
          'revoked',
          '2021-01-01T00:00:00Z',
          null,
          '{}'::jsonb,
          'source-access integration revocation'
        )
      `;
      await expect(reader.getSourceAccess(sourceId)).resolves.toMatchObject({
        permissionCurrent: true,
        permissionDecision: "revoked",
        permissions: {},
      });

      await connection.sql`
        insert into source_permissions (
          source_id,
          decision,
          reviewed_at,
          valid_until,
          permissions,
          notes
        ) values (
          ${sourceId},
          'approved',
          '2022-01-01T00:00:00Z',
          '2023-01-01T00:00:00Z',
          '{"catalog":true}'::jsonb,
          'source-access integration expired approval'
        )
      `;
      await expect(reader.getSourceAccess(sourceId)).resolves.toMatchObject({
        permissionCurrent: false,
        permissionDecision: "approved",
      });

      await connection.sql`
        insert into source_permissions (
          source_id,
          decision,
          reviewed_at,
          valid_until,
          permissions,
          notes
        ) values (
          ${sourceId},
          'approved',
          '2098-01-01T00:00:00Z',
          '2099-01-01T00:00:00Z',
          '{"catalog":true}'::jsonb,
          'source-access integration future approval'
        )
      `;
      // A future review cannot shadow the latest decision that is current now.
      await expect(reader.getSourceAccess(sourceId)).resolves.toMatchObject({
        permissionCurrent: false,
        permissionDecision: "approved",
      });

      await connection.sql`
        update data_sources
        set
          permission_reviewed_at = '2022-01-01T00:00:00Z',
          permission_expires_at = '2023-01-01T00:00:00Z'
        where id = ${sourceId}
      `;
      await expect(reader.getSourceAccess(sourceId)).resolves.toMatchObject({
        sourcePermissionCurrent: false,
      });
    });
  },
);

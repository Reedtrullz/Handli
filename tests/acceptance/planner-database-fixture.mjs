// Source-only raw SQL workload fixture for the actual web-role planner reader (original14/U24).
// Runs only inside the existing hosted CI PostgreSQL service; callers pass an admin postgres.js handle.
import { createHash } from "node:crypto";

export const V1_CHAINS = [
  "bunnpris", "extra", "rema-1000", "fudi", "holdbart", "meny", "havaristen",
  "joker", "spar", "fastcandy", "europris", "engrossnett", "oda",
];
export const FIXTURE = Object.freeze({
  gtinCount: 50,
  chainCount: V1_CHAINS.length,
  historyPerPair: 11,
  maxRows: 10_000,
  maxDatabaseBytes: 128 * 1024 * 1024,
  minute: 60_000,
  day: 24 * 60 * 60_000,
});
// Pending-native expectation: 50 products + 7801 prices (650 current, 7150 history, 1 unknown-scope) + 650 priced coverage.
export const EXPECTED_BASE_UNION_ROWS = 50 + (50 * 13 * 12 + 1) + 50 * 13;

export function guardCiDatabaseUrls(env) {
  if (env.CI !== "true" || env.RUN_DB_INTEGRATION !== "1") {
    throw new Error("Planner workload fixture requires CI=true and RUN_DB_INTEGRATION=1");
  }
  const check = (name, expectedUser) => {
    let url;
    try { url = new URL(env[name] ?? ""); } catch { throw new Error(name + " is not a valid URL"); }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) || !loopback || url.port !== "5432"
      || url.pathname !== "/handleplan" || decodeURIComponent(url.username) !== expectedUser
    ) {
      throw new Error(name + " is not the declared disposable CI database");
    }
    return env[name];
  };
  return { adminUrl: check("DATABASE_URL", "handleplan"), webUrl: check("WEB_DATABASE_URL", "handleplan_web") };
}

export function withCheckDigit(body) {
  const weighted = [...body].reduce(
    (sum, digit, index) => sum + Number(digit) * ((body.length - index) % 2 === 1 ? 3 : 1), 0);
  return body + String((10 - (weighted % 10)) % 10);
}

export function fixtureNamespace(nowMs = Date.now(), pid = process.pid) {
  return "o14w-" + nowMs.toString(36) + "-" + pid.toString(36);
}

export function fixtureGtins(nowMs = Date.now(), pid = process.pid) {
  const base = ((nowMs + pid) % 1_000_000) * 1000;
  return Array.from({ length: FIXTURE.gtinCount }, (_, index) =>
    withCheckDigit("708" + String(base + index).padStart(9, "0")));
}

const sha = (text) => createHash("sha256").update(text).digest("hex");
const iso = (t0, minutes) => new Date(t0 + Math.round(minutes * FIXTURE.minute)).toISOString();

// Pure price plan. Offsets are minutes relative to the database clock at fixture start.
export function buildPricePlan(ns) {
  const rows = [];
  const add = (row) => rows.push({ ...row, rawHash: sha(row.key) });
  for (let gi = 0; gi < FIXTURE.gtinCount; gi += 1) {
    for (let ci = 0; ci < FIXTURE.chainCount; ci += 1) {
      const winner = 1000 + gi * 7 + ci * 13;
      add({ key: ns + ":c:" + gi + ":" + ci, gi, chain: V1_CHAINS[ci], amountOre: winner,
        observedMin: -60, run: "current", scope: true, kind: "current" });
      for (let k = 1; k <= FIXTURE.historyPerPair; k += 1) {
        add({ key: ns + ":h:" + gi + ":" + ci + ":" + k, gi, chain: V1_CHAINS[ci],
          amountOre: winner + 100 + 17 * k, observedMin: -(3 + 2.5 * (k - 1)) * 1440,
          run: "history", scope: true, kind: "history" });
      }
    }
  }
  // Included in the raw reader result with unknown geography; cheapest so a wrong eligibility claim is visible.
  add({ key: ns + ":unknown", gi: 1, chain: "oda", amountOre: 1, observedMin: -80,
    run: "current", scope: false, kind: "unknown-scope" });
  return rows;
}

// Rows the reader must drop: future-dated, older than the 33 day window, missing evidence hash/reference.
export function buildExcludedPlan(ns) {
  const row = (suffix, extra) => ({ key: ns + ":x:" + suffix, gi: 0, chain: "oda", amountOre: 1,
    scope: true, rawHash: sha(ns + ":x:" + suffix), ...extra });
  return [
    row("future", { observedMin: 1440, run: "current", kind: "future" }),
    row("too-old", { observedMin: -40 * 1440, run: "history", kind: "too-old" }),
    row("missing-evidence", { observedMin: -62, run: "current", kind: "missing-evidence",
      rawHash: null, sourceReference: null }),
  ];
}

const INSERT_PRICES = "insert into price_observations ("
  + "evidence_key, product_id, chain, amount_ore, observed_at, fetched_at, source_id, source_reference,"
  + " ingestion_run_id, geographic_scope_id, evidence_level, confidence, claim_eligibility, raw_record_hash) "
  + "select t.evidence_key, t.product_id, t.chain, t.amount_ore, t.observed_at, t.fetched_at, t.source_id,"
  + " t.source_reference, t.ingestion_run_id, t.geographic_scope_id, 'chain', 100, t.claim_eligibility,"
  + " t.raw_record_hash from jsonb_to_recordset($1::jsonb) as t("
  + "evidence_key text, product_id bigint, chain text, amount_ore integer, observed_at timestamptz,"
  + " fetched_at timestamptz, source_id text, source_reference text, ingestion_run_id bigint,"
  + " geographic_scope_id bigint, claim_eligibility text, raw_record_hash text) "
  + "returning id::integer as id, evidence_key, product_id::integer as product_id, chain, amount_ore,"
  + " observed_at, fetched_at, source_id, source_reference, ingestion_run_id::integer as ingestion_run_id,"
  + " geographic_scope_id::integer as geographic_scope_id, claim_eligibility, raw_record_hash";

function insertPrices(sql, rows, t0, ctx) {
  const payload = rows.map((r) => ({
    evidence_key: r.key, product_id: ctx.productIds[r.gi], chain: r.chain, amount_ore: r.amountOre,
    observed_at: iso(t0, r.observedMin), fetched_at: iso(t0, r.observedMin + 1),
    source_id: ctx.sourceId,
    source_reference: r.sourceReference === undefined ? ctx.ns + ":ref" : r.sourceReference,
    ingestion_run_id: ctx.runs[r.run], geographic_scope_id: r.scope === false ? null : ctx.scopeId,
    claim_eligibility: r.run === "history" ? "historical_eligible" : "ordinary_only",
    raw_record_hash: r.rawHash,
  }));
  return sql.unsafe(INSERT_PRICES, [JSON.stringify(payload)]);
}

async function insertSource(sql, id, label, t0) {
  const params = [id, label, iso(t0, -1440), iso(t0, 2 * 1440)];
  await sql.unsafe("insert into data_sources (id, display_name, source_kind, runtime_state,"
    + " permission_reviewed_at, permission_expires_at) values ($1::text, $2::text, 'ordinary_price',"
    + " 'approved', $3::timestamptz, $4::timestamptz)", params);
  await sql.unsafe("insert into source_permissions (source_id, decision, reviewed_at, valid_until, permissions, notes)"
    + " values ($1::text, 'approved', $2::timestamptz, $3::timestamptz,"
    + " '{\"ordinaryPrice\":true,\"priceHistory\":true}'::jsonb, 'planner workload fixture approval')",
  [id, params[2], params[3]]);
}

async function startRun(sql, ns, sourceId, runType, tag, t0, startedMin) {
  const [run] = await sql.unsafe("insert into ingestion_runs (job_id, source_id, run_type, status, started_at, counts)"
    + " values ($1::text, $2::text, $3::text, 'running', $4::timestamptz, '{}'::jsonb) returning id::integer as id",
  [ns + ":" + tag, sourceId, runType, iso(t0, startedMin)]);
  return run.id;
}

async function completeRun(sql, runId, count, t0, completedMin) {
  const counts = JSON.stringify({ accepted: count, failed: 0, fetched: count, persisted: count, quarantined: 0, unknown: 0 });
  await sql.unsafe("update ingestion_runs set status = 'completed', completed_at = $2::timestamptz,"
    + " counts = $3::jsonb where id = $1::bigint", [runId, iso(t0, completedMin), counts]);
}

export async function databaseSizeBytes(sql) {
  const [row] = await sql.unsafe("select pg_database_size(current_database())::bigint::text as bytes");
  return Number(row.bytes);
}

export async function dbClockMs(sql) {
  const [row] = await sql.unsafe("select clock_timestamp() as t");
  return new Date(row.t).getTime();
}

// Sampled pg_database_size accounting between write batches; not a kernel disk quota.
async function assertDatabaseBound(sql) {
  if ((await databaseSizeBytes(sql)) > FIXTURE.maxDatabaseBytes) {
    throw new Error("Planner workload fixture exceeded the 128MiB database size bound");
  }
}

// Inserts the whole owned namespace and returns raw INSERT ... RETURNING records as the oracle.
export async function insertFixture(sql, ns = fixtureNamespace(), gtins = fixtureGtins()) {
  const sizeBefore = await databaseSizeBytes(sql);
  if (sizeBefore > FIXTURE.maxDatabaseBytes) {
    throw new Error("Planner workload database already exceeds the 128MiB size bound before any write");
  }
  const t0 = await dbClockMs(sql);
  const sourceId = ns + "-main";
  await insertSource(sql, sourceId, "Planner workload main source", t0);
  const label = ns + " product ";
  const products = await sql.unsafe("insert into canonical_products (display_name, package_amount, package_unit,"
    + " units_per_pack, status) select $1::text || g, 1, 'package', 1, 'active' from generate_series(0, $2::int) g"
    + " returning id::integer as id, display_name", [label, gtins.length - 1]);
  const productIds = [];
  for (const p of products) productIds[Number(p.display_name.slice(label.length))] = p.id;
  const identifiers = await sql.unsafe("insert into product_identifiers (product_id, scheme, value, confidence, verified_at)"
    + " select t.product_id, 'ean13', t.value, 100, $2::timestamptz from jsonb_to_recordset($1::jsonb)"
    + " as t(product_id bigint, value text) returning product_id::integer as product_id, value",
  [JSON.stringify(gtins.map((value, gi) => ({ product_id: productIds[gi], value }))), iso(t0, -120)]);
  const [scope] = await sql.unsafe("insert into geographic_scopes (scope_key, scope_kind, label, country_code, status)"
    + " values ($1::text, 'national', 'Norway', 'NO', 'active') returning id::integer as id", [ns + ":national"]);
  const runs = {
    current: await startRun(sql, ns, sourceId, "benchmark-prices", "current", t0, -360),
    history: await startRun(sql, ns, sourceId, "historical-prices", "history", t0, -359),
  };
  const ctx = { ns, sourceId, productIds, runs, scopeId: scope.id };
  const plan = [...buildPricePlan(ns), ...buildExcludedPlan(ns)];
  const prices = [];
  for (const run of ["current", "history"]) {
    const rows = plan.filter((r) => r.run === run);
    for (let i = 0; i < rows.length; i += 2000) {
      prices.push(...await insertPrices(sql, rows.slice(i, i + 2000), t0, ctx));
      await assertDatabaseBound(sql);
    }
  }
  const kindByKey = new Map(plan.map((r) => [r.key, r.kind]));
  for (const p of prices) p.kind = kindByKey.get(p.evidence_key);
  const coveragePayload = [];
  for (let gi = 0; gi < gtins.length; gi += 1) {
    for (const chain of V1_CHAINS) {
      coveragePayload.push({ product_id: productIds[gi], chain, scope: scope.id, checked: iso(t0, -70) });
    }
  }
  // Null-scope row so the unique (run, product, chain, scope) index allows an extra too-old row.
  coveragePayload.push({ product_id: productIds[0], chain: "oda", scope: null, checked: iso(t0, -100 * 60) });
  const coverage = await sql.unsafe("insert into price_coverage_checks (ingestion_run_id, product_id, chain,"
    + " geographic_scope_id, state, reason, checked_at) select $2::bigint, t.product_id, t.chain, t.scope, 'priced',"
    + " 'planner workload priced coverage', t.checked from jsonb_to_recordset($1::jsonb)"
    + " as t(product_id bigint, chain text, scope bigint, checked timestamptz)"
    + " returning id::integer as id, product_id::integer as product_id, chain,"
    + " geographic_scope_id::integer as geographic_scope_id, checked_at, ingestion_run_id::integer as ingestion_run_id",
  [JSON.stringify(coveragePayload), runs.current]);
  await completeRun(sql, runs.current, prices.filter((p) => p.ingestion_run_id === runs.current).length, t0, -30);
  await completeRun(sql, runs.history, prices.filter((p) => p.ingestion_run_id === runs.history).length, t0, -31);
  const sizeAfter = await databaseSizeBytes(sql);
  if (sizeAfter > FIXTURE.maxDatabaseBytes) {
    throw new Error("Planner workload fixture exceeded the 128MiB database size bound");
  }
  return { ns, t0, gtins, sourceId, productIds, identifiers, scopeId: scope.id, runs, prices, coverage,
    sizeBefore, sizeAfter, bulk: [] };
}

// Adds completed historical rows from a separate approved source; each call is its own append-only run.
export async function insertBoundaryHistory(sql, fx, count, tag) {
  const bulkSourceId = fx.ns + "-bulk";
  const t0 = await dbClockMs(sql);
  if (fx.bulk.length === 0) await insertSource(sql, bulkSourceId, "Planner workload boundary source", t0);
  const run = await startRun(sql, fx.ns, bulkSourceId, "historical-prices", "bulk-" + tag, t0, -120);
  const rows = Array.from({ length: count }, (_, i) => ({
    key: fx.ns + ":b:" + tag + ":" + i, gi: 2, chain: V1_CHAINS[i % V1_CHAINS.length], amountOre: 2000 + i,
    observedMin: -(2 + (i % 28)) * 1440 - i, run: "history", rawHash: sha(fx.ns + ":b:" + tag + ":" + i),
  }));
  const ctx = { ns: fx.ns, sourceId: bulkSourceId, productIds: fx.productIds, runs: { history: run }, scopeId: fx.scopeId };
  const inserted = [];
  for (let i = 0; i < rows.length; i += 2000) {
    inserted.push(...await insertPrices(sql, rows.slice(i, i + 2000), t0, ctx));
    await assertDatabaseBound(sql);
  }
  await completeRun(sql, run, inserted.length, t0, -60);
  fx.bulk.push(...inserted);
  return inserted;
}

export async function insertRevocation(sql, sourceId) {
  const [row] = await sql.unsafe("insert into source_permissions (source_id, decision, reviewed_at, valid_until,"
    + " permissions, notes) values ($1::text, 'revoked', clock_timestamp() - interval '1 minute', null, '{}'::jsonb,"
    + " 'planner workload revocation') returning id::integer as id", [sourceId]);
  return row;
}

// Evaluation clock taken after all authored rows are terminal; later inserts need a new clock.
export async function evaluatedAtNow(sql) {
  const [row] = await sql.unsafe("select clock_timestamp() + interval '1 millisecond' as t");
  return new Date(row.t);
}

// Independent oracle: the UNION definition (products + eligible prices + coverage) evaluated from authored rows in JS.
export function expectedUnionRows(fx, sourceIds, at) {
  const ev = at.getTime();
  const inWindow = (t, ms) => t >= ev - ms && t <= ev;
  const prices = [...fx.prices, ...fx.bulk].filter((p) => sourceIds.includes(p.source_id)
    && p.raw_record_hash !== null && p.source_reference !== null
    && inWindow(new Date(p.observed_at).getTime(), 33 * FIXTURE.day)
    && new Date(p.fetched_at).getTime() <= ev);
  const coverage = fx.coverage.filter((c) => inWindow(new Date(c.checked_at).getTime(), 72 * 60 * FIXTURE.minute));
  return { products: fx.gtins.length, prices, coverage, total: fx.gtins.length + prices.length + coverage.length };
}

// Second oracle: raw admin SQL counts of the same three definitions over the owned namespace only.
export async function rawUnionCount(sql, fx, sourceIds, at) {
  const [row] = await sql.unsafe("select"
    + " (select count(*) from product_identifiers where value in (select jsonb_array_elements_text($1::jsonb)))::int as products,"
    + " (select count(*) from price_observations po where po.source_id in (select jsonb_array_elements_text($2::jsonb))"
    + " and po.product_id in (select jsonb_array_elements_text($3::jsonb)::bigint)"
    + " and po.observed_at >= $4::timestamptz - interval '33 days' and po.observed_at <= $4::timestamptz"
    + " and po.fetched_at <= $4::timestamptz and po.raw_record_hash is not null and po.source_reference is not null)::int as prices,"
    + " (select count(*) from price_coverage_checks c inner join ingestion_runs r on r.id = c.ingestion_run_id"
    + " where r.source_id in (select jsonb_array_elements_text($2::jsonb))"
    + " and c.product_id in (select jsonb_array_elements_text($3::jsonb)::bigint)"
    + " and c.checked_at >= $4::timestamptz - interval '72 hours' and c.checked_at <= $4::timestamptz)::int as coverage",
  [JSON.stringify(fx.gtins), JSON.stringify(sourceIds), JSON.stringify(fx.productIds), at.toISOString()]);
  return { ...row, total: row.products + row.prices + row.coverage };
}

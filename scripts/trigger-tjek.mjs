#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = await mkdtemp(resolve(tmpdir(), "handleplan-tjek-"));
const entry = resolve(dir, "entry.ts");
const bundle = resolve(dir, "trigger.mjs");
const q = JSON.stringify;
const source = [
  'import { createDatabase } from ' + q(resolve(root, "packages/db/src/client.ts")) + ';',
  'import { TjekClient } from ' + q(resolve(root, "packages/tjek/src/index.ts")) + ';',
  'import { createTjekHandlers } from ' + q(resolve(root, "apps/worker/src/tjek-handlers.ts")) + ';',
  'const dbUrl = process.env.DATABASE_URL, apiKey = process.env.TJEK_API_KEY;',
  'if (!dbUrl || !apiKey) throw new Error("DATABASE_URL and TJEK_API_KEY are required");',
  'const c = createDatabase(dbUrl), signal = new AbortController().signal;',
  'const stamp = Date.now().toString(), jobId = "tjek:manual:" + stamp;',
  'try { const h = createTjekHandlers({ client: new TjekClient({ apiKey }), db: c.db })["official-offer-discovery"];',
  'if (!h) throw new Error("Tjek handler is not composed");',
  'const result = await h({ signal, jobId, kind: "official-offer-discovery", runId: "manual:" + stamp, sourceId: "tjek", fenceToken: "manual-trigger" });',
  'console.log(JSON.stringify({ jobId, result })); } finally { await c.close(); }',
].join("\\n");
const run = (cmd, args) => new Promise((ok, fail) => { const p = spawn(cmd, args, { cwd: root, stdio: "inherit" }); p.on("error", fail); p.on("exit", code => code === 0 ? ok() : fail(new Error(cmd + " exited " + code))); });
try { await writeFile(entry, source); await run("pnpm", ["exec", "esbuild", entry, "--bundle", "--platform=node", "--format=esm", "--target=node22", "--outfile=" + bundle]); await run(process.execPath, [bundle]); } finally { await rm(dir, { recursive: true, force: true }); }

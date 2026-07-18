import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sentinel = process.env.HANDLEPLAN_E2E_SENTINEL;
const modulePath = fileURLToPath(import.meta.url);
const expectedServerSuffix = path.join(
  "apps",
  "web",
  ".next",
  "standalone",
  "apps",
  "web",
  "server.js",
);
const importIndex = process.execArgv.findIndex((value) => value === "--import");

if (
  typeof sentinel !== "string"
  || !/^handleplan-e2e-[0-9a-f]{48}$/u.test(sentinel)
  || process.env.NODE_ENV !== "production"
  || process.env.HANDLEPLAN_MODE !== "fake"
  || process.env.HANDLEPLAN_E2E_FAKE_PRODUCTION_TOKEN !== sentinel
  || process.env.KASSAL_API_KEY !== sentinel
  || process.env.HANDLEPLAN_E2E_PUBLIC_ORIGIN !== "https://127.0.0.1:3109"
  || process.env.HOSTNAME !== "127.0.0.1"
  || process.env.PORT !== "3108"
  || process.argv[1] === undefined
  || !path.resolve(process.argv[1]).endsWith(expectedServerSuffix)
  || importIndex < 0
  || process.execArgv[importIndex + 1] === undefined
  || path.resolve(process.execArgv[importIndex + 1]) !== modulePath
) {
  throw new Error("public browser production-fake preloader proof is incomplete");
}

let inheritedProof = "";
try {
  inheritedProof = readFileSync(3, "utf8");
} catch {
  throw new Error("public browser production-fake inherited proof is unavailable");
}
if (inheritedProof !== sentinel) {
  throw new Error("public browser production-fake inherited proof is invalid");
}

Object.defineProperty(
  globalThis,
  Symbol.for("handleplan.e2e.loopback-production-browser-fake-runtime.v1"),
  { configurable: false, enumerable: false, value: sentinel, writable: false },
);

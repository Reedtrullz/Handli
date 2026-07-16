import { cpSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = process.cwd();
const standaloneRoot = path.join(projectRoot, ".next", "standalone", "apps", "web");
const publicTarget = path.join(standaloneRoot, "public");
const staticTarget = path.join(standaloneRoot, ".next", "static");

for (const target of [publicTarget, staticTarget]) {
  rmSync(target, { force: true, recursive: true });
}
cpSync(path.join(projectRoot, "public"), publicTarget, { recursive: true });
cpSync(path.join(projectRoot, ".next", "static"), staticTarget, { recursive: true });

process.env.HOSTNAME = "127.0.0.1";
process.env.PORT = "3115";
await import(pathToFileURL(path.join(standaloneRoot, "server.js")).href);

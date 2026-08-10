import { runProductionWorkerProcess } from "./bootstrap";

const shutdown = new AbortController();
const requestShutdown = () => shutdown.abort();
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

try {
  process.exitCode = await runProductionWorkerProcess(process.env, shutdown.signal);
} catch {
  // Deliberately fixed text: errors at this boundary may contain credentials or source payloads.
  console.error("Handleplan worker terminated before a clean shutdown");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", requestShutdown);
  process.removeListener("SIGTERM", requestShutdown);
}

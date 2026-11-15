const WORKFLOW_DISPATCH_URL =
  "https://api.github.com/repos/Reedtrullz/Handli/actions/workflows/external-public-monitor.yml/dispatches";

/**
 * Dispatches the external public monitor on the default branch.
 *
 * GitHub's schedule event is best-effort and currently drops most fifteen-minute
 * ticks. This Worker is the primary clock; the workflow's schedule entry remains
 * a backup. The monitor is read-only, so an occasional duplicate run is harmless.
 */
export async function dispatchMonitor(env, fetchImpl = globalThis.fetch) {
  const token = env?.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length < 20) {
    throw new Error("GITHUB_TOKEN is not configured");
  }
  const response = await fetchImpl(WORKFLOW_DISPATCH_URL, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "handli-monitor-dispatch",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (response.status !== 204) {
    // Keep the log bounded and free of the request token.
    const detail = (await response.text()).slice(0, 200).replace(/\s+/gu, " ");
    throw new Error(`GitHub workflow dispatch failed: ${response.status} ${detail}`);
  }
}

export default {
  async scheduled(_controller, env) {
    await dispatchMonitor(env);
  },
};

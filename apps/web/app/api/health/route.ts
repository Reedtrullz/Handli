export function GET(): Response {
  return Response.json(
    {
      status: "ok",
      version: 1,
      commit: process.env.APP_COMMIT_SHA ?? "development",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export function GET(): Response {
  return Response.json({ status: "ok", version: 1 });
}

import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptSources = process.env.NODE_ENV === "production"
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
const publicContentSecurityPolicy = `default-src 'self'; ${scriptSources}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests`;
const reviewContentSecurityPolicy = `default-src 'self'; ${scriptSources}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests`;

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(appDirectory, "../.."),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: publicContentSecurityPolicy,
          },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
        ],
      },
      {
        // The private review UI renders bytes fetched from its same-origin,
        // Access-protected API via ephemeral object URLs. Keep blob rendering
        // scoped to this route; public pages retain the stricter global policy.
        source: "/review/:path*",
        headers: [{
          key: "Content-Security-Policy",
          value: reviewContentSecurityPolicy,
        }],
      },
    ];
  },
  turbopack: {
    root: path.resolve(appDirectory, "../.."),
  },
};

export default nextConfig;

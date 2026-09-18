import type { NextConfig } from "next";
const config: NextConfig = {
  output: process.env.QUASAR_STANDALONE === '1' ? "standalone" : undefined,
  serverExternalPackages: ["better-sqlite3"],
  // The tailnet-only dev server is reached through tailscale serve.
  allowedDevOrigins: ["home-server.tail210f05.ts.net"],
  async headers() {
    return [
      { source: "/:path*", headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Frame-Options", value: "DENY" }
      ] },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] }
    ];
  }
};
export default config;

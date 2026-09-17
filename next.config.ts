import type { NextConfig } from "next";
const config: NextConfig = {
  output: process.env.QUASAR_STANDALONE === '1' ? "standalone" : undefined,
  serverExternalPackages: ["better-sqlite3"],
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

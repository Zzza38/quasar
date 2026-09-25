import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Defense in depth on top of React's escaping. Next's inline runtime scripts and the theme-boot script in
 * layout.tsx need 'unsafe-inline' unless every page gets a per-request nonce from a proxy, which would force
 * dynamic rendering; see node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md ("Without
 * Nonces"). The rest still limits an injected script: no third-party script, fetch, frame, plugin or <base>,
 * and forms may only post to this origin. Google sign-in needs no form-action source: next-auth/react's signIn()
 * posts with fetch and then navigates, and NextAuth's built-in sign-in page (the one form that posted towards
 * Google) is never shown because authOptions.pages points at '/' (src/server/auth.ts).
 * Development adds 'unsafe-eval', which React uses for server error stacks.
 */
export const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // data: covers the timetable scan previews (canvas.toDataURL in scan-schedule.tsx) and inline SVG/icon data URLs.
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Features the app never uses. The camera is left alone: the scan photo picker opens it through file-input capture. */
export const permissionsPolicy = "geolocation=(), microphone=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), browsing-topics=()";

export const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Permissions-Policy", value: permissionsPolicy },
  // Browsers ignore HSTS on plain-HTTP responses, so this only pins HTTPS once a visitor has reached the
  // HTTPS origin; the proxy must still redirect http:// to https:// (docs/OPERATIONS.md). Left out of
  // `next dev` so a development host is never pinned.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];

const config: NextConfig = {
  output: process.env.QUASAR_STANDALONE === '1' ? "standalone" : undefined,
  serverExternalPackages: ["better-sqlite3"],
  // The tailnet-only dev server is reached through tailscale serve.
  allowedDevOrigins: ["home-server.tail210f05.ts.net"],
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Rendered per request for the signed-in account (src/app/page.tsx, src/app/admin/page.tsx): never cached by a
      // browser or proxy. The service worker's own cache of the public, signed-out render is unaffected.
      { source: "/", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/(today|schedule|tasks|classes|school|people|messages)", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/admin", headers: [{ key: "Cache-Control", value: "private, no-store" }] },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] }
    ];
  }
};
export default config;

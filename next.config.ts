import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The microphone, camera and screen sharing are Studio's own: calls and the message box's mic, and
  // showing a call your screen or camera (only on a tap). Nothing embedded gets them; the rest stay off.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  // Browsers ignore HSTS over plain http, so this is inert on the local dev/QA servers.
  // No `preload`: that's a one-way commitment for the whole domain; add it deliberately.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];
// No full Content-Security-Policy yet: Next's inline bootstrap scripts need nonces (which
// force every page dynamic) and a wrong policy silently breaks the app. The policy above
// only sets frame-ancestors, which is the clickjacking defense.

const nextConfig: NextConfig = {
  // Lets the QA server (npm run qa:serve) run alongside the dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

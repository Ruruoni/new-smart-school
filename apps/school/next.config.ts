import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Strict CSP in production. 'unsafe-inline' for scripts/styles is required by Next's hydration payload without a
// per-request nonce; everything else is locked to same-origin. (Dev needs eval for HMR.)
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// One id per build: it versions the service worker's caches (see src/lib/sw-source.ts). Set BUILD_ID for reproducible builds.
const BUILD = process.env.BUILD_ID ?? new Date().toISOString().replace(/\D/g, "").slice(0, 14);

const config: NextConfig = {
  typescript: { tsconfigPath: "tsconfig.build.json" }, // production build type-checks src/ only; tests are checked by `pnpm typecheck`
  generateBuildId: async () => BUILD,
  env: { SW_BUILD: BUILD },
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@smartschool/protocol"],
  // Native / Node-only packages must not be bundled.
  serverExternalPackages: ["pdfkit", "exceljs", "@node-rs/argon2", "pg", "nodemailer", "@prisma/adapter-pg", "dejavu-fonts-ttf"],
  outputFileTracingIncludes: { "/api/**": ["./node_modules/dejavu-fonts-ttf/ttf/DejaVuSans*.ttf", "./node_modules/dejavu-fonts-ttf/package.json"] },
  experimental: { serverActions: { bodySizeLimit: "12mb" } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), fullscreen=(self)" },
        ],
      },
      // The service worker must be revalidated on every load so updates roll out.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Service-Worker-Allowed", value: "/" }] },
    ];
  },
};

export default config;

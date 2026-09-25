import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const config: NextConfig = {
  typescript: { tsconfigPath: "tsconfig.build.json" }, // production build type-checks src/ only; tests are checked by `pnpm typecheck`
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@smartschool/protocol"],
  serverExternalPackages: ["@node-rs/argon2", "pg", "@prisma/adapter-pg"],
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "Content-Security-Policy", value: csp },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Cache-Control", value: "no-store" },
    ] }];
  },
};
export default config;

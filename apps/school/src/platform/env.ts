import { z } from "zod";
import { ConfigError } from "./errors";

/** A secret that must be exactly 32 random bytes, base64. Checked here so a malformed one fails at start-up with an instruction, not as a 500 at the first encryption. */
const key32 = (name: string) => z.string().refine((v) => Buffer.from(v, "base64").length === 32, `${name} must be 32 random bytes, base64 — generate one with: openssl rand -base64 32`);

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ENCRYPTION_KEY: key32("APP_ENCRYPTION_KEY"),
  APP_SIGNING_SECRET: key32("APP_SIGNING_SECRET"),
  STORAGE_DIR: z.string().default("./.data/storage"),
  BACKUP_DIR: z.string().default("./.data/backups"),
  CLOUD_URL: z.string().optional().default(""),
  CLOUD_PUBLIC_KEY: z.string().optional().default(""),
  /// Set to "true" only when the school serves the app over HTTPS (local Wi-Fi HTTP deployments must leave it false).
  /** "auto" (default): Secure only when the request arrived over HTTPS. "true"/"false" force it. */
  SESSION_COOKIE_SECURE: z.enum(["true", "false", "auto"]).default("auto"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

/** Parsed lazily so `next build` and tooling don't need a full runtime environment. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      // Names and problems only — never the values (they may be secrets).
      throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.code === "invalid_type" && String((i as { input?: unknown }).input) === "undefined" ? "is not set" : i.message}`));
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test hook. */
export function resetEnvCache() {
  cached = undefined;
}

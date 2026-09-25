import { z } from "zod";
import { CloudConfigError } from "./errors";

const schema = z.object({
  CLOUD_DATABASE_URL: z.string().min(1),
  CLOUD_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "CLOUD_ENCRYPTION_KEY must be 32 random bytes, base64 — generate one with: openssl rand -base64 32"),
  CLOUD_SIGNING_PRIVATE_KEY: z.string().min(40),
  CLOUD_SIGNING_PUBLIC_KEY: z.string().min(40),
  BACKUP_STORAGE_DIR: z.string().default("./.data/backups"),
  /** "auto" (default): Secure only when the request arrived over HTTPS (directly or via X-Forwarded-Proto). "true"/"false" force it. */
  SESSION_COOKIE_SECURE: z.enum(["true", "false", "auto"]).default("auto"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});
export type CloudEnv = z.infer<typeof schema>;
let cached: CloudEnv | undefined;
export function env(): CloudEnv {
  if (!cached) {
    const p = schema.safeParse(process.env);
    if (!p.success) throw new CloudConfigError(p.error.issues.map((i) => `${i.path.join(".")}: ${i.code === "invalid_type" && String((i as { input?: unknown }).input) === "undefined" ? "is not set" : i.message}`)); // names + problems only, never values
    cached = p.data;
  }
  return cached;
}
export const resetEnvCache = () => void (cached = undefined);

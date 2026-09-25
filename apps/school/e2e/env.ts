import { createPrivateKey, createPublicKey } from "node:crypto";
import { resolve } from "node:path";

export const E2E_PORT = 3200;
export const E2E_DB = "smartschool_school_e2e";
export const ADMIN_DB_URL = "postgresql://smartschool:smartschool@localhost:5433/postgres";
export const DATABASE_URL = `postgresql://smartschool:smartschool@localhost:5433/${E2E_DB}`;

// ── The Control Tower (apps/cloud), run for real alongside the school ──
export const CLOUD_PORT = 3210;
export const CLOUD_DB = "smartschool_cloud_e2e";
export const CLOUD_DB_URL = `postgresql://smartschool:smartschool@localhost:5433/${CLOUD_DB}`;
export const CLOUD_URL = `http://127.0.0.1:${CLOUD_PORT}`;
export const CLOUD_DIR = resolve("../cloud");
export const OPERATOR = { email: "root@tower.test", name: "Tower Root", password: "tower-root-password-1" };
export const SUPPORT_OPERATOR = { email: "support@tower.test", name: "Tower Support", password: "tower-support-password-1" };
export const VIEWER_OPERATOR = { email: "viewer@tower.test", name: "Tower Viewer", password: "tower-viewer-password-1" };

// A fixed Ed25519 key pair so the tower (signs licences) and the school (verifies them) agree across processes. Test-only.
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" });
const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64");
const CLOUD_PRIVATE_B64 = b64(priv.export({ type: "pkcs8", format: "pem" }) as string);
export const CLOUD_PUBLIC_B64 = b64(createPublicKey(priv).export({ type: "spki", format: "pem" }) as string);
export const CLOUD_ENV = {
  CLOUD_DATABASE_URL: CLOUD_DB_URL,
  CLOUD_ENCRYPTION_KEY: Buffer.alloc(32, 21).toString("base64"),
  CLOUD_SIGNING_PRIVATE_KEY: CLOUD_PRIVATE_B64,
  CLOUD_SIGNING_PUBLIC_KEY: CLOUD_PUBLIC_B64,
  BACKUP_STORAGE_DIR: resolve(".data/e2e-cloud-backups"),
  SESSION_COOKIE_SECURE: "false",
  NODE_ENV: "production",
};

/** Environment for the app + worker under test. Fixed test-only secrets. */
export const APP_ENV = {
  DATABASE_URL,
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString("base64"),
  APP_SIGNING_SECRET: Buffer.alloc(32, 13).toString("base64"),
  STORAGE_DIR: resolve(".data/e2e-storage"),
  BACKUP_DIR: resolve(".data/e2e-backups"),
  SESSION_COOKIE_SECURE: "false",
  CLOUD_PUBLIC_KEY: CLOUD_PUBLIC_B64,
  NODE_ENV: "production",
};
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const ADMIN = { username: "principal.admin", password: "Sup3r-secret-Adm1n" };

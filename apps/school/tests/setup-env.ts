// Runs in every test worker before any module is imported.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://smartschool:smartschool@localhost:5433/smartschool_school_test";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.APP_SIGNING_SECRET = Buffer.alloc(32, 9).toString("base64");
process.env.STORAGE_DIR = "./.data/test-storage";
(process.env as Record<string, string>).NODE_ENV = "test";

// ── Cloud control plane (used by the end-to-end sync tests) ──
import { generateKeyPairSync } from "node:crypto";
const kp = generateKeyPairSync("ed25519");
const b64 = (k: typeof kp.publicKey | typeof kp.privateKey, type: "spki" | "pkcs8") => Buffer.from(k.export({ type, format: "pem" }) as string).toString("base64");
process.env.CLOUD_DATABASE_URL = process.env.CLOUD_TEST_DATABASE_URL ?? "postgresql://smartschool:smartschool@localhost:5433/smartschool_cloud_test";
process.env.CLOUD_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.CLOUD_SIGNING_PRIVATE_KEY = b64(kp.privateKey, "pkcs8");
process.env.CLOUD_SIGNING_PUBLIC_KEY = b64(kp.publicKey, "spki");
process.env.CLOUD_PUBLIC_KEY = b64(kp.publicKey, "spki"); // what the school embeds to verify licenses/commands
process.env.BACKUP_STORAGE_DIR = "./.data/test-cloud-backups";
process.env.BACKUP_DIR = "./.data/test-backups";

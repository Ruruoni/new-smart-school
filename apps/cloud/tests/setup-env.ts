import { generateKeyPairSync } from "node:crypto";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const b64 = (k: typeof publicKey | typeof privateKey, type: "spki" | "pkcs8") => Buffer.from(k.export({ type, format: "pem" }) as string).toString("base64");
process.env.CLOUD_DATABASE_URL = process.env.CLOUD_TEST_DATABASE_URL ?? "postgresql://smartschool:smartschool@localhost:5433/smartschool_cloud_test";
process.env.CLOUD_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.CLOUD_SIGNING_PRIVATE_KEY ??= b64(privateKey, "pkcs8");
process.env.CLOUD_SIGNING_PUBLIC_KEY ??= b64(publicKey, "spki");
process.env.BACKUP_STORAGE_DIR = "./.data/test-backups";
(process.env as Record<string, string>).NODE_ENV = "test";

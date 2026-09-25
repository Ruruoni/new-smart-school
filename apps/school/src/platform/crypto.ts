import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function hmac(data: string, purpose: string): string {
  return createHmac("sha256", Buffer.from(env().APP_SIGNING_SECRET, "base64")).update(`${purpose}:${data}`).digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const key = () => {
  const k = Buffer.from(env().APP_ENCRYPTION_KEY, "base64");
  if (k.length !== 32) throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return k;
};

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (all base64url). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(blob: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported secret format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

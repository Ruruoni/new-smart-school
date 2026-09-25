import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

export const sha256 = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

const key = () => { const k = Buffer.from(env().CLOUD_ENCRYPTION_KEY, "base64"); if (k.length !== 32) throw new Error("CLOUD_ENCRYPTION_KEY must decode to 32 bytes"); return k; };

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

/** Stable JSON (sorted keys) so equal payloads hash equally regardless of key order. */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") { const o = v as Record<string, unknown>; return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`; }
  return JSON.stringify(v);
}
export const payloadHash = (p: unknown) => sha256(canonical(p));

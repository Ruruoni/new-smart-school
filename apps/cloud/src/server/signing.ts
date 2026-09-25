import { importPKCS8, importSPKI, SignJWT, jwtVerify } from "jose";
import { CommandClaims, LicenseClaims } from "@smartschool/protocol";
import { env } from "./env";

const pem = (b64: string) => Buffer.from(b64, "base64").toString("utf8");
const priv = () => importPKCS8(pem(env().CLOUD_SIGNING_PRIVATE_KEY), "EdDSA");

/** Ed25519-signed license. Schools verify it offline with the embedded public key. */
export async function signLicense(c: { code: string; plan: string; modules: string[]; features: Record<string, boolean>; graceDays: number; status: "ACTIVE" | "SUSPENDED"; expiresAt: Date; issuedAt?: Date }): Promise<string> {
  const iat = Math.floor((c.issuedAt ?? new Date()).getTime() / 1000);
  const claims: LicenseClaims = { iss: "smartschool-cloud", sub: c.code, plan: c.plan, modules: c.modules, features: c.features, graceDays: c.graceDays, status: c.status, iat, exp: Math.floor(c.expiresAt.getTime() / 1000) };
  return new SignJWT(claims as unknown as Record<string, unknown>).setProtectedHeader({ alg: "EdDSA", typ: "JWT" }).sign(await priv());
}

export async function signCommand(c: { code: string; id: string; cmd: CommandClaims["cmd"]; args: Record<string, unknown>; expiresAt: Date }): Promise<string> {
  const claims: CommandClaims = { iss: "smartschool-cloud", sub: c.code, jti: c.id, cmd: c.cmd, args: c.args, iat: Math.floor(Date.now() / 1000), exp: Math.floor(c.expiresAt.getTime() / 1000) };
  return new SignJWT(claims as unknown as Record<string, unknown>).setProtectedHeader({ alg: "EdDSA", typ: "JWT" }).sign(await priv());
}

export async function verifyOwnToken(token: string) {
  const key = await importSPKI(pem(env().CLOUD_SIGNING_PUBLIC_KEY), "EdDSA");
  return (await jwtVerify(token, key, { issuer: "smartschool-cloud", algorithms: ["EdDSA"] })).payload;
}

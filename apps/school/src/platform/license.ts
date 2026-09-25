import { importSPKI, jwtVerify } from "jose";
import { LicenseClaims } from "@smartschool/protocol";
import { db, type Tx } from "./db";
import { env } from "./env";
import { CORE_MODULES, MODULES, type ModuleKey } from "./rbac/catalog";

/**
 * What the installation may do right now.
 *  FULL       – normal operation (ACTIVE, GRACE, or standalone trial)
 *  READ_ONLY  – license lapsed beyond grace: all data stays readable/exportable, writes are refused
 *  ADMIN_ONLY – suspended by the control plane: only the Primary Admin can enter (to export / back up / contact support)
 *
 * School data is never held hostage, and a *missing* cloud connection never degrades the mode — only a
 * cryptographically verified license/command can.
 */
export type OperatingMode = "FULL" | "READ_ONLY" | "ADMIN_ONLY";

export interface LicenseState {
  status: "ACTIVE" | "GRACE" | "EXPIRED" | "SUSPENDED" | "TRIAL" | "TRIAL_EXPIRED";
  mode: OperatingMode;
  plan: string;
  modules: ReadonlySet<ModuleKey>;
  features: Readonly<Record<string, boolean>>;
  expiresAt: Date | null;
  graceEndsAt: Date | null;
  message: string | null;
}

export const TRIAL_DAYS = 30;
const DAY = 86_400_000;
const ALL_MODULES: ReadonlySet<ModuleKey> = new Set(MODULES);

async function publicKey() {
  const b64 = env().CLOUD_PUBLIC_KEY;
  if (!b64) return null;
  const pem = Buffer.from(b64, "base64").toString("utf8");
  return importSPKI(pem, "EdDSA");
}

/** Verify a cloud-issued license token. Throws if the signature, issuer or audience is wrong. */
export async function verifyLicenseToken(token: string, installationCode: string): Promise<LicenseClaims> {
  const key = await publicKey();
  if (!key) throw new Error("CLOUD_PUBLIC_KEY is not configured; cannot verify license");
  const { payload } = await jwtVerify(token, key, { issuer: "smartschool-cloud", subject: installationCode, algorithms: ["EdDSA"], clockTolerance: 0 }).catch(
    // An expired token is still cryptographically valid evidence of the grace window; re-parse without exp.
    async (err) => {
      if (err?.code === "ERR_JWT_EXPIRED") {
        return jwtVerify(token, key, { issuer: "smartschool-cloud", subject: installationCode, algorithms: ["EdDSA"], currentDate: new Date(0) });
      }
      throw err;
    },
  );
  return LicenseClaims.parse(payload);
}

/** Pure decision function (unit-tested): claims + clock → state. */
export function deriveLicenseState(claims: LicenseClaims, now: Date): LicenseState {
  const expiresAt = new Date(claims.exp * 1000);
  const graceEndsAt = new Date(expiresAt.getTime() + claims.graceDays * DAY);
  const modules = new Set<ModuleKey>([...CORE_MODULES, ...(claims.modules.filter((m) => (MODULES as readonly string[]).includes(m)) as ModuleKey[])]);
  const base = { plan: claims.plan, modules, features: claims.features, expiresAt, graceEndsAt };
  if (claims.status === "SUSPENDED") {
    return { ...base, status: "SUSPENDED", mode: "ADMIN_ONLY", message: "This installation has been suspended. Contact SmartSchool support." };
  }
  if (now <= expiresAt) return { ...base, status: "ACTIVE", mode: "FULL", message: null };
  if (now <= graceEndsAt) {
    const days = Math.ceil((graceEndsAt.getTime() - now.getTime()) / DAY);
    return { ...base, status: "GRACE", mode: "FULL", message: `License expired. Full access continues for ${days} more day(s) — please renew.` };
  }
  return { ...base, status: "EXPIRED", mode: "READ_ONLY", message: "License expired. Records are read-only until the license is renewed." };
}

export function deriveTrialState(installedAt: Date, now: Date): LicenseState {
  const endsAt = new Date(installedAt.getTime() + TRIAL_DAYS * DAY);
  const base = { plan: "trial", modules: ALL_MODULES, features: {}, expiresAt: endsAt, graceEndsAt: endsAt };
  if (now <= endsAt) {
    const days = Math.ceil((endsAt.getTime() - now.getTime()) / DAY);
    return { ...base, status: "TRIAL", mode: "FULL", message: `Trial period: ${days} day(s) left. Register this installation to continue.` };
  }
  return { ...base, status: "TRIAL_EXPIRED", mode: "READ_ONLY", message: "Trial ended. Records are read-only until this installation is licensed." };
}

let cache: { at: number; state: LicenseState } | undefined;
export function invalidateLicenseCache() {
  cache = undefined;
}

/** Local, offline-safe license evaluation (re-verifies the stored token signature every load, cached briefly). */
export async function currentLicense(now = new Date()): Promise<LicenseState> {
  if (cache && now.getTime() - cache.at < 5_000 && env().NODE_ENV !== "test") return cache.state;
  const inst = await db.schoolInstallation.findFirst({ select: { installationCode: true, createdAt: true } });
  const row = await db.license.findFirst({ where: { isActive: true } });
  let state: LicenseState;
  if (!inst) {
    state = deriveTrialState(now, now);
  } else if (!row) {
    state = deriveTrialState(inst.createdAt, now);
  } else {
    try {
      const claims = await verifyLicenseToken(row.token, inst.installationCode);
      state = deriveLicenseState(claims, now);
    } catch (err) {
      // A stored token that no longer verifies (tampering / wrong key) never grants access: treat as expired.
      console.error("stored license failed verification", (err as Error).message);
      state = { status: "EXPIRED", mode: "READ_ONLY", plan: row.plan, modules: new Set(CORE_MODULES), features: {}, expiresAt: row.expiresAt, graceEndsAt: row.expiresAt, message: "License could not be verified. Contact support." };
    }
  }
  cache = { at: now.getTime(), state };
  return state;
}

/** Persist a freshly received (already verified by the caller) license token. */
export async function storeLicense(tx: Tx, token: string, claims: LicenseClaims): Promise<void> {
  await tx.license.updateMany({ where: { isActive: true }, data: { isActive: false } });
  await tx.license.create({
    data: {
      plan: claims.plan,
      status: claims.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
      modules: claims.modules,
      features: claims.features,
      issuedAt: new Date(claims.iat * 1000),
      expiresAt: new Date(claims.exp * 1000),
      graceDays: claims.graceDays,
      token,
      lastVerifiedAt: new Date(),
      isActive: true,
    },
  });
  invalidateLicenseCache();
}

import { beforeEach, describe, expect, it } from "vitest";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { deriveLicenseState, deriveTrialState, verifyLicenseToken, currentLicense, storeLicense, invalidateLicenseCache } from "@/platform/license";
import { resetEnvCache } from "@/platform/env";
import { db } from "@/platform/db";
import { installTestSchool, resetDb } from "./helpers";

const DAY = 86_400_000;
const claims = (over: Record<string, unknown> = {}) => ({
  iss: "smartschool-cloud" as const, sub: "SS-TEST", plan: "standard", modules: ["finance", "cbt"], features: {}, graceDays: 30, status: "ACTIVE" as const,
  iat: 1_700_000_000, exp: 1_700_000_000 + 365 * 86_400, ...over,
});
const at = (offsetDays: number) => new Date((1_700_000_000 + 365 * 86_400) * 1000 + offsetDays * DAY);

describe("license state (pure)", () => {
  it("ACTIVE before expiry", () => expect(deriveLicenseState(claims(), at(-1))).toMatchObject({ status: "ACTIVE", mode: "FULL" }));
  it("GRACE after expiry keeps full operation", () => expect(deriveLicenseState(claims(), at(10))).toMatchObject({ status: "GRACE", mode: "FULL" }));
  it("READ_ONLY after grace, never a hard lock-out", () => expect(deriveLicenseState(claims(), at(31))).toMatchObject({ status: "EXPIRED", mode: "READ_ONLY" }));
  it("SUSPENDED is admin-only", () => expect(deriveLicenseState(claims({ status: "SUSPENDED" }), at(-100))).toMatchObject({ status: "SUSPENDED", mode: "ADMIN_ONLY" }));
  it("core modules are always available; licensed modules only as granted", () => {
    const s = deriveLicenseState(claims({ modules: ["finance"] }), at(-1));
    expect(s.modules.has("students")).toBe(true);
    expect(s.modules.has("finance")).toBe(true);
    expect(s.modules.has("cbt")).toBe(false);
  });
  it("trial: full for 30 days then read-only", () => {
    const t0 = new Date("2026-01-01");
    expect(deriveTrialState(t0, new Date(t0.getTime() + 29 * DAY)).mode).toBe("FULL");
    expect(deriveTrialState(t0, new Date(t0.getTime() + 31 * DAY)).mode).toBe("READ_ONLY");
  });
});

describe("license token verification (Ed25519)", () => {
  let privateKey: CryptoKey;
  beforeEach(async () => {
    const kp = await generateKeyPair("EdDSA", { extractable: true });
    privateKey = kp.privateKey;
    process.env.CLOUD_PUBLIC_KEY = Buffer.from(await exportSPKI(kp.publicKey)).toString("base64");
    resetEnvCache();
    await resetDb();
    await installTestSchool();
  });
  const sign = (c: Record<string, unknown>, key = () => privateKey) => new SignJWT(c).setProtectedHeader({ alg: "EdDSA" }).sign(key());

  it("accepts a valid token and applies it end to end", async () => {
    const inst = await db.schoolInstallation.findFirstOrThrow();
    const now = Math.floor(Date.now() / 1000);
    const c = claims({ sub: inst.installationCode, iat: now, exp: now + 86_400 * 100, modules: ["finance"] });
    const token = await sign(c);
    const parsed = await verifyLicenseToken(token, inst.installationCode);
    await db.$transaction((tx) => storeLicense(tx, token, parsed));
    invalidateLicenseCache();
    const state = await currentLicense();
    expect(state.status).toBe("ACTIVE");
    expect(state.modules.has("cbt")).toBe(false);
  });
  it("rejects a token signed by another key", async () => {
    const other = await generateKeyPair("EdDSA");
    const token = await sign(claims({ sub: "SS-X" }), () => other.privateKey as CryptoKey);
    await expect(verifyLicenseToken(token, "SS-X")).rejects.toThrow();
  });
  it("rejects a token issued to a different installation", async () => {
    const token = await sign(claims({ sub: "SS-OTHER" }));
    await expect(verifyLicenseToken(token, "SS-MINE")).rejects.toThrow();
  });
  it("still parses an expired token so the grace window can be computed", async () => {
    const token = await sign(claims({ sub: "SS-X", iat: 1_600_000_000, exp: 1_600_000_100 }));
    const parsed = await verifyLicenseToken(token, "SS-X");
    expect(deriveLicenseState(parsed, new Date(1_600_000_100_000 + 40 * DAY)).status).toBe("EXPIRED");
  });
  it("a tampered stored license never grants access", async () => {
    const inst = await db.schoolInstallation.findFirstOrThrow();
    await db.license.create({ data: { plan: "x", modules: ["cbt"], issuedAt: new Date(), expiresAt: new Date(Date.now() + 1e9), token: "not.a.jwt", isActive: true } });
    invalidateLicenseCache();
    const state = await currentLicense();
    expect(state.mode).toBe("READ_ONLY");
    expect(inst.installationCode).toBeTruthy();
  });
});

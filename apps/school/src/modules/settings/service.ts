import { z } from "zod";
import { db, transact } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { CORE_MODULES, MODULES, type ModuleKey } from "@/platform/rbac/catalog";
import { FEATURES, type FeatureKey } from "@/platform/features";
import { forbidden, notFound, validation } from "@/platform/errors";
import { assertUpdated } from "@/platform/util";
import { SETTINGS, getSetting, setSetting, type SettingKey } from "@/platform/settings";
import { invalidateLicenseCache, currentLicense } from "@/platform/license";

export const ProfileInput = z.object({
  version: z.number().int(),
  schoolName: z.string().trim().min(2).max(120).optional(),
  shortName: z.string().trim().max(30).nullable().optional(),
  motto: z.string().trim().max(200).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  state: z.string().trim().max(80).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().email().nullable().optional(),
  website: z.string().url().nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  timezone: z.string().max(60).optional(),
  logoFileId: z.string().uuid().nullable().optional(),
});

export async function getProfile() {
  const { cloudSecretEnc: _omit, ...rest } = await db.schoolInstallation.findFirstOrThrow();
  return rest;
}

export async function updateProfile(ctx: SecurityContext, raw: z.infer<typeof ProfileInput>) {
  const { version, ...patch } = ProfileInput.parse(raw);
  return transact(async (tx) => {
    const before = await tx.schoolInstallation.findFirstOrThrow();
    const r = await tx.schoolInstallation.updateMany({ where: { id: before.id, version }, data: { ...patch, version: { increment: 1 } } });
    assertUpdated(r.count, "School profile", before.version);
    const { cloudSecretEnc: _a, ...b } = before;
    const after = await tx.schoolInstallation.findUniqueOrThrow({ where: { id: before.id } });
    const { cloudSecretEnc: _b, ...a } = after;
    await auditIn(tx, ctx, { action: "settings.profile_update", module: "platform", entityType: "SchoolInstallation", entityId: before.id, before: b, after: a });
    return a;
  });
}

export async function readPolicy<K extends SettingKey>(key: K) {
  return getSetting(key);
}

export async function updatePolicy<K extends SettingKey>(ctx: SecurityContext, key: K, value: unknown) {
  if (!(key in SETTINGS)) throw notFound("Setting");
  return transact(async (tx) => {
    const before = await getSetting(key, tx);
    const after = await setSetting(tx, key, value);
    await auditIn(tx, ctx, { action: "settings.policy_update", module: "platform", entityType: "SchoolSetting", entityId: key, before, after });
    return after;
  });
}

/** The Primary Admin's feature-toggle matrix: license grant × local switch × flag state, per module/feature. */
export async function moduleMatrix() {
  const license = await currentLicense();
  const rows = await db.moduleSetting.findMany();
  const local = new Map(rows.map((r) => [r.moduleKey, r.enabled]));
  const modules = MODULES.map((key) => ({
    key,
    isCore: (CORE_MODULES as readonly string[]).includes(key),
    licensed: license.modules.has(key),
    enabled: (CORE_MODULES as readonly string[]).includes(key) ? true : license.modules.has(key) && (local.get(key) ?? true),
    localEnabled: local.get(key) ?? true,
  }));
  const flags = await db.featureFlag.findMany({ orderBy: { key: "asc" } });
  return { modules, flags: flags.map((f) => ({ key: f.key, enabled: license.features[f.key] ?? f.enabled, source: f.source, locked: f.source === "CLOUD" || f.key in license.features })), license: { status: license.status, mode: license.mode, plan: license.plan, message: license.message } };
}

export async function setModuleEnabled(ctx: SecurityContext, moduleKey: string, enabled: boolean) {
  if (!(MODULES as readonly string[]).includes(moduleKey)) throw notFound("Module");
  if ((CORE_MODULES as readonly string[]).includes(moduleKey as ModuleKey) && !enabled) throw forbidden("Core modules cannot be switched off");
  return transact(async (tx) => {
    const before = await tx.moduleSetting.findUnique({ where: { moduleKey } });
    await tx.moduleSetting.upsert({ where: { moduleKey }, create: { moduleKey, enabled }, update: { enabled } });
    await auditIn(tx, ctx, { action: "module.toggle", module: "platform", entityType: "ModuleSetting", entityId: moduleKey, before: { enabled: before?.enabled ?? true }, after: { enabled } });
  });
}

export async function setFeatureFlag(ctx: SecurityContext, key: string, enabled: boolean) {
  if (!(key in FEATURES)) throw notFound("Feature");
  const license = await currentLicense();
  return transact(async (tx) => {
    const before = await tx.featureFlag.findUnique({ where: { key } });
    if (before?.source === "CLOUD" || key in license.features) throw forbidden("This feature is controlled by your license and cannot be changed locally");
    await tx.featureFlag.upsert({ where: { key }, create: { key, enabled, module: key.split(".")[0] }, update: { enabled } });
    await auditIn(tx, ctx, { action: "feature.toggle", module: "platform", entityType: "FeatureFlag", entityId: key, before: { enabled: before?.enabled ?? FEATURES[key as FeatureKey] }, after: { enabled } });
    invalidateLicenseCache();
  });
}

export function assertKnownSetting(key: string): asserts key is SettingKey {
  if (!(key in SETTINGS)) throw validation(`Unknown setting: ${key}`);
}

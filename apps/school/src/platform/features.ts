import { db } from "./db";
import { CORE_MODULES, type ModuleKey } from "./rbac/catalog";
import { currentLicense } from "./license";

/** Feature-flag registry: key → default. Rows in `feature_flags` override; CLOUD-sourced rows beat LOCAL. */
export const FEATURES = {
  "cbt.fullscreen_enforcement": true,
  "examprep.mock_exams": true,
  "finance.online_payments": false, // premium: payment gateway boundary
  "communication.sms": false, // premium
  "communication.whatsapp": false, // premium
  "attendance.rfid": false, // premium: hardware integration boundary
  "attendance.fingerprint": false, // premium
  "analytics.advanced": true,
  "automation.scheduled_rules": true,
} as const satisfies Record<string, boolean>;
export type FeatureKey = keyof typeof FEATURES;

export async function isModuleEnabled(module: ModuleKey): Promise<boolean> {
  if ((CORE_MODULES as readonly string[]).includes(module)) return true;
  const license = await currentLicense();
  if (!license.modules.has(module)) return false;
  const row = await db.moduleSetting.findUnique({ where: { moduleKey: module } });
  return row?.enabled ?? true;
}

export async function enabledModules(): Promise<ModuleKey[]> {
  const license = await currentLicense();
  const rows = await db.moduleSetting.findMany();
  const off = new Set(rows.filter((r) => !r.enabled).map((r) => r.moduleKey));
  return [...license.modules].filter((m) => (CORE_MODULES as readonly string[]).includes(m) || !off.has(m));
}

export async function isFeatureEnabled(key: FeatureKey): Promise<boolean> {
  const license = await currentLicense();
  if (key in license.features) return license.features[key]!;
  const row = await db.featureFlag.findUnique({ where: { key } });
  return row?.enabled ?? FEATURES[key];
}

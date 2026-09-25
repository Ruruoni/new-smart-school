import { db, transact } from "@/platform/db";
import { installSchool, syncPermissionCatalog, seedFeatureFlags, seedGradingDefaults, type InstallInput } from "@/platform/provision";
import { seedTemplates } from "@/modules/communication/templates";
import { seedDefaultRules } from "@/modules/automation/engine";

/**
 * Application-level defaults that need several modules (kept out of the platform core so the core never
 * depends on feature modules). Idempotent: safe to call at every start-up and after every upgrade.
 */
export async function ensureDefaults(): Promise<void> {
  await transact(async (tx) => {
    await syncPermissionCatalog(tx);
    await seedFeatureFlags(tx);
    await seedGradingDefaults(tx);
    await seedTemplates(tx);
    await seedDefaultRules(tx);
  });
}

/** First-run setup used by the setup wizard, the CLI and tests. */
export async function installWithDefaults(input: InstallInput) {
  const r = await installSchool(input);
  await ensureDefaults();
  return r;
}

export async function needsSetup(): Promise<boolean> {
  return (await db.schoolInstallation.count()) === 0;
}

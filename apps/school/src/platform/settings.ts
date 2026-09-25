import { z } from "zod";
import { db, type Tx } from "./db";
import type { Prisma } from "@/generated/prisma/client";

/** Typed, defaulted school settings. Every school-specific policy lives here — never in code. */
export const SETTINGS = {
  "finance.lockout": {
    category: "finance",
    schema: z.object({
      enabled: z.boolean().default(false),
      /// Days past an invoice's due date before the lockout applies.
      graceDays: z.number().int().min(0).default(0),
      /// Outstanding amount (₦) at or below which no lockout applies.
      minimumOutstanding: z.number().min(0).default(0),
      message: z.string().default(""),
    }),
  },
  "attendance.policy": {
    category: "attendance",
    schema: z.object({
      /// Arrivals after this local time (HH:MM) are LATE.
      lateAfter: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
      /// Arrivals after this time are ABSENT unless excused.
      absentAfter: z.string().regex(/^\d{2}:\d{2}$/).default("11:00"),
      notifyGuardiansOnAbsence: z.boolean().default(true),
    }),
  },
  "cbt.defaults": {
    category: "cbt",
    schema: z.object({
      requireFullscreen: z.boolean().default(true),
      autosaveSeconds: z.number().int().min(2).default(10),
      /// Small allowance after the deadline for the final in-flight save.
      graceSeconds: z.number().int().min(0).default(15),
      /// How long after the deadline answers that were made in time (offline) may still sync in.
      offlineSyncWindowMinutes: z.number().int().min(0).max(120).default(10),
    }),
  },
  "results.policy": {
    category: "results",
    schema: z.object({
      showPositions: z.boolean().default(true),
      cumulativeAcrossTerms: z.boolean().default(true),
      promotionMinimumAverage: z.number().min(0).max(100).default(40),
    }),
  },
  "notifications.policy": {
    category: "notifications",
    schema: z.object({
      channels: z.array(z.enum(["IN_APP", "EMAIL", "SMS", "WHATSAPP"])).default(["IN_APP"]),
      absenceThreshold: z.number().int().min(1).default(3),
    }),
  },
  "admissions.policy": {
    category: "admissions",
    schema: z.object({
      open: z.boolean().default(true),
      /// Application fee in ₦ (0 = no fee).
      applicationFee: z.number().min(0).default(0),
      requireFeePaidBeforeReview: z.boolean().default(true),
      requiredDocuments: z.array(z.string()).default(["BIRTH_CERTIFICATE", "PASSPORT_PHOTO"]),
      instructions: z.string().default(""),
    }),
  },
  "branding": {
    category: "branding",
    schema: z.object({
      primaryColor: z.string().default("#0f766e"),
      reportCardFooter: z.string().default(""),
      principalName: z.string().default(""),
    }),
  },
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;

export async function getSetting<K extends SettingKey>(key: K, client: Pick<Tx, "schoolSetting"> = db): Promise<SettingValue<K>> {
  const row = await client.schoolSetting.findUnique({ where: { key } });
  return SETTINGS[key].schema.parse(row?.value ?? {}) as SettingValue<K>;
}

export async function setSetting<K extends SettingKey>(tx: Tx, key: K, value: unknown): Promise<SettingValue<K>> {
  const parsed = SETTINGS[key].schema.parse(value) as SettingValue<K>;
  await tx.schoolSetting.upsert({
    where: { key },
    create: { key, category: SETTINGS[key].category, value: parsed as Prisma.InputJsonValue },
    update: { value: parsed as Prisma.InputJsonValue, version: { increment: 1 } },
  });
  return parsed;
}

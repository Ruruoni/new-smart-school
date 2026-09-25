import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, transact, type Tx } from "./db";
import { audit } from "./audit";
import { hashPassword, assertPasswordPolicy } from "./password";
import { conflict } from "./errors";
import { DEFAULT_ROLES, PERMISSIONS } from "./rbac/catalog";
import { FEATURES } from "./features";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateInstallationCode(): string {
  const bytes = randomBytes(6);
  return "SS-" + [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/**
 * Bring the permissions table and default roles in line with the code catalog. Idempotent and safe to run at
 * every start-up / upgrade:
 *  – new permissions are inserted;
 *  – the Primary Admin role always holds every permission;
 *  – other system roles get their defaults only when first created (schools customise them afterwards, and an
 *    upgrade must never silently re-grant something the Primary Admin removed).
 */
export async function syncPermissionCatalog(tx: Tx): Promise<{ permissions: number; rolesCreated: string[] }> {
  for (const perm of PERMISSIONS) {
    await tx.permission.upsert({
      where: { key: perm.action },
      create: { key: perm.action, module: perm.module, action: perm.action, description: perm.description },
      update: { module: perm.module, description: perm.description },
    });
  }
  const all = await tx.permission.findMany({ select: { id: true, key: true } });
  const byKey = new Map(all.map((p) => [p.key, p.id]));
  const created: string[] = [];

  for (const def of DEFAULT_ROLES) {
    let role = await tx.role.findUnique({ where: { key: def.key } });
    const isNew = !role;
    if (!role) {
      role = await tx.role.create({ data: { key: def.key, name: def.name, description: def.description, isSystem: true, isProtected: def.isProtected ?? false } });
      created.push(def.key);
    }
    const wanted = def.permissions === "*" ? all.map((p) => p.key) : def.permissions.filter((k) => byKey.has(k));
    if (isNew || def.permissions === "*") {
      await tx.rolePermission.createMany({ data: wanted.map((k) => ({ roleId: role.id, permissionId: byKey.get(k)! })), skipDuplicates: true });
    }
  }
  return { permissions: all.length, rolesCreated: created };
}

/** Default grading: WAEC-style A1–F9 with CA 20 + CA 20 + Exam 60. Every value is editable per school. */
export async function seedGradingDefaults(tx: Tx) {
  if (await tx.gradingScheme.count()) return;
  const scheme = await tx.gradingScheme.create({ data: { name: "Standard (A1–F9)", isDefault: true } });
  const bands: [string, number, number, string, boolean, number][] = [
    ["A1", 75, 100, "Excellent", true, 4.0], ["B2", 70, 74.99, "Very Good", true, 3.5], ["B3", 65, 69.99, "Good", true, 3.0],
    ["C4", 60, 64.99, "Credit", true, 2.5], ["C5", 55, 59.99, "Credit", true, 2.0], ["C6", 50, 54.99, "Credit", true, 1.5],
    ["D7", 45, 49.99, "Pass", true, 1.0], ["E8", 40, 44.99, "Pass", true, 0.5], ["F9", 0, 39.99, "Fail", false, 0],
  ];
  await tx.gradeRule.createMany({
    data: bands.map(([grade, min, max, remark, isPass, gp]) => ({ schemeId: scheme.id, grade, minScore: min, maxScore: max, remark, isPass, gradePoint: gp })),
  });
  await tx.assessmentType.createMany({
    data: [
      { schemeId: scheme.id, name: "1st Continuous Assessment", code: "CA1", maxScore: 20, isExam: false, sortOrder: 1 },
      { schemeId: scheme.id, name: "2nd Continuous Assessment", code: "CA2", maxScore: 20, isExam: false, sortOrder: 2 },
      { schemeId: scheme.id, name: "Examination", code: "EXAM", maxScore: 60, isExam: true, sortOrder: 3 },
    ],
  });
}

export async function seedFeatureFlags(tx: Tx) {
  for (const [key, enabled] of Object.entries(FEATURES)) {
    await tx.featureFlag.upsert({ where: { key }, create: { key, enabled, module: key.split(".")[0] }, update: {} });
  }
}

export const InstallInput = z.object({
  schoolName: z.string().trim().min(2).max(120),
  shortName: z.string().trim().max(30).optional(),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().email().optional(),
  admin: z.object({
    username: z.string().trim().toLowerCase().min(3).max(40).regex(/^[a-z0-9._-]+$/, "Letters, numbers, dot, dash, underscore only"),
    password: z.string(),
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    email: z.string().email().optional(),
    phone: z.string().trim().max(30).optional(),
  }),
});
export type InstallInput = z.infer<typeof InstallInput>;

/** First-run setup: creates the installation identity, the protected Primary Admin and sane defaults. */
export async function installSchool(raw: InstallInput) {
  const input = InstallInput.parse(raw);
  assertPasswordPolicy(input.admin.password);
  const passwordHash = await hashPassword(input.admin.password);

  return transact(async (tx) => {
    if (await tx.schoolInstallation.count()) throw conflict("This installation has already been set up");
    await syncPermissionCatalog(tx);
    await seedGradingDefaults(tx);
    await seedFeatureFlags(tx);

    const installation = await tx.schoolInstallation.create({
      data: {
        installationCode: generateInstallationCode(),
        schoolName: input.schoolName,
        shortName: input.shortName,
        address: input.address,
        city: input.city,
        state: input.state,
        phone: input.phone,
        email: input.email,
        setupCompletedAt: new Date(),
      },
    });
    const admin = await tx.user.create({
      data: {
        username: input.admin.username,
        passwordHash,
        firstName: input.admin.firstName,
        lastName: input.admin.lastName,
        email: input.admin.email,
        phone: input.admin.phone,
        userType: "ADMIN",
        isPrimaryAdmin: true,
        passwordChangedAt: new Date(),
      },
    });
    const role = await tx.role.findUniqueOrThrow({ where: { key: "primary_admin" } });
    await tx.userRole.create({ data: { userId: admin.id, roleId: role.id } });
    await audit(tx, { actorId: admin.id, actorName: `${admin.firstName} ${admin.lastName}`, action: "installation.created", module: "platform", entityType: "SchoolInstallation", entityId: installation.id, after: { schoolName: installation.schoolName, installationCode: installation.installationCode } });
    return { installation, adminId: admin.id };
  });
}

export async function isInstalled(): Promise<boolean> {
  return (await db.schoolInstallation.count()) > 0;
}

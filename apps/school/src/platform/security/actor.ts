import { db } from "../db";
import { currentLicense } from "../license";
import { buildContext, type SecurityContext } from "./context";

/**
 * A SecurityContext for a user acting through a background job (imports, reports). Uses the CURRENT role
 * grants of that user, so a job can never do more than its owner could do right now.
 */
export async function actorContext(userId: string, requestId = `job-${Date.now()}`): Promise<SecurityContext> {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const inst = await db.schoolInstallation.findFirstOrThrow();
  const roles = await db.userRole.findMany({ where: { userId, scopeType: "*" }, select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } } });
  const permissions = new Set(roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key)));
  return buildContext({
    requestId, ip: null, sessionId: "background-job",
    user: { id: u.id, username: u.username, name: `${u.firstName} ${u.lastName}`, userType: u.userType, isPrimaryAdmin: u.isPrimaryAdmin, mustChangePassword: false },
    installation: { id: inst.id, code: inst.installationCode, schoolName: inst.schoolName }, license: await currentLicense(), permissions, scopedPermissions: new Map(),
  });
}

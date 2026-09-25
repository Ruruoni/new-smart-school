import type { UserType } from "@/generated/prisma/client";
import type { LicenseState } from "../license";
import { forbidden } from "../errors";

export interface SecurityContext {
  requestId: string;
  ip: string | null;
  sessionId: string;
  user: { id: string; username: string; name: string; userType: UserType; isPrimaryAdmin: boolean; mustChangePassword: boolean };
  installation: { id: string; code: string; schoolName: string };
  license: LicenseState;
  /** Unscoped permission keys granted through roles held for the whole school. */
  permissions: ReadonlySet<string>;
  /** permission → resource scopes (e.g. "CLASS:<id>") for scoped role assignments. */
  scopedPermissions: ReadonlyMap<string, ReadonlySet<string>>;
  can(permission: string): boolean;
  canIn(permission: string, scopeType: string, scopeId: string): boolean;
  require(permission: string): void;
}

export function buildContext(base: Omit<SecurityContext, "can" | "canIn" | "require">): SecurityContext {
  const can = (p: string) => base.user.isPrimaryAdmin || base.permissions.has(p);
  const canIn = (p: string, type: string, id: string) => can(p) || (base.scopedPermissions.get(p)?.has(`${type}:${id}`) ?? false);
  return {
    ...base,
    can,
    canIn,
    require(p: string) {
      if (!can(p)) throw forbidden(undefined, { permission: p });
    },
  };
}

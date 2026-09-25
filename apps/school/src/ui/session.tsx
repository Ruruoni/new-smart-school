"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, useApi } from "@/lib/api";
import { Skeleton } from "./kit";

export interface Me {
  user: { id: string; username: string; name: string; userType: "ADMIN" | "TEACHER" | "STAFF" | "PARENT" | "STUDENT"; isPrimaryAdmin: boolean; mustChangePassword: boolean; teacherId: string | null; parentId: string | null };
  school: { schoolName: string; shortName: string | null; logoFileId: string | null; primaryColor: string };
  permissions: string[];
  modules: string[];
  license: { status: string; mode: "FULL" | "READ_ONLY" | "ADMIN_ONLY"; message: string | null; plan: string };
  unreadNotifications: number;
  banner: string | null;
  notifications: { id: string; title: string; body: string; readAt: string | null; createdAt: string }[];
}

interface SessionValue {
  me: Me;
  can: (...perms: string[]) => boolean;
  hasModule: (m?: string) => boolean;
  reload: () => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);
export const useSession = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside <SessionProvider>");
  return v;
};

/** Loads the signed-in user's grants from the server. Redirects to sign-in / forced password change as required. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  // Refreshed every 90 s (paused while hidden/offline) so the notification bell and licence banner don't go stale in a long-lived tab.
  const q = useApi<Me>("/auth/me", { refreshMs: 90_000 });

  useEffect(() => {
    const goLogin = () => router.replace(`/login?next=${encodeURIComponent(path)}`);
    const goPw = () => router.replace("/change-password");
    window.addEventListener("ss:unauthenticated", goLogin);
    window.addEventListener("ss:password-change", goPw);
    return () => { window.removeEventListener("ss:unauthenticated", goLogin); window.removeEventListener("ss:password-change", goPw); };
  }, [router, path]);

  useEffect(() => {
    if (q.error?.status === 401) router.replace(`/login?next=${encodeURIComponent(path)}`);
    else if (q.data?.user.mustChangePassword) router.replace("/change-password");
  }, [q.error, q.data, router, path]);

  const signOut = useCallback(async () => {
    await api.post("/auth/logout").catch(() => undefined);
    router.replace("/login");
  }, [router]);

  const value = useMemo<SessionValue | null>(() => {
    if (!q.data) return null;
    const perms = new Set(q.data.permissions);
    const mods = new Set(q.data.modules);
    return {
      me: q.data,
      can: (...p) => q.data!.user.isPrimaryAdmin || p.length === 0 || p.some((x) => perms.has(x)),
      hasModule: (m) => !m || mods.has(m),
      reload: q.reload,
      signOut,
    };
  }, [q.data, q.reload, signOut]);

  if (!value) {
    return (
      <div className="grid min-h-dvh place-items-center bg-paper p-6" aria-busy="true">
        {q.error && q.error.status !== 401 ? (
          <div className="max-w-md text-center"><h1 className="font-serif text-2xl">We can't reach the school server</h1><p className="mt-2 text-ink-500">{q.error.message}</p><button onClick={q.reload} className="mt-4 min-h-11 cursor-pointer rounded-(--radius-ctl) bg-brand-700 px-4 font-bold text-white">Try again</button></div>
        ) : (
          <div className="w-72 space-y-3"><Skeleton className="h-8 w-40" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
        )}
      </div>
    );
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Hide UI the user has no permission for. Purely cosmetic: the server enforces every rule. */
export function Can({ perm, module, children, fallback = null }: { perm?: string[]; module?: string; children: ReactNode; fallback?: ReactNode }) {
  const s = useSession();
  return s.can(...(perm ?? [])) && s.hasModule(module) ? <>{children}</> : <>{fallback}</>;
}

/** Read-only license mode: disables writes at the UI level (the API refuses them regardless). */
export const useReadOnly = () => useSession().me.license.mode !== "FULL";

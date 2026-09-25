"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { homeFor } from "@/lib/nav";
import type { Me } from "@/ui/session";

/** Front door: send each person to where they work. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    (async () => {
      try {
        const st = await api.get<{ needsSetup: boolean }>("/setup/status");
        if (st.needsSetup) return router.replace("/setup");
        const me = await api.get<Me>("/auth/me");
        router.replace(me.user.mustChangePassword ? "/change-password" : homeFor(me.user.userType, me.permissions));
      } catch { router.replace("/login"); }
    })();
  }, [router]);
  return <div className="grid min-h-dvh place-items-center text-ink-500" aria-busy="true">Opening SmartSchool…</div>;
}

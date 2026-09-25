"use client";
import { createContext, useContext, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { call, useApi } from "@/lib/api";
import { Button } from "@/ui/kit";

export interface Me { id: string; email: string; name: string; role: "SUPER_ADMIN" | "SUPPORT" | "VIEWER" }
const Ctx = createContext<Me | null>(null);
export const useMe = () => { const m = useContext(Ctx); if (!m) throw new Error("useMe outside the tower layout"); return m; };
export const canSupport = (m: Me) => m.role === "SUPPORT" || m.role === "SUPER_ADMIN";
export const canAdmin = (m: Me) => m.role === "SUPER_ADMIN";

const NAV = [["/fleet", "Fleet"], ["/alerts", "Alerts"], ["/conflicts", "Sync conflicts"], ["/releases", "Releases & flags"], ["/operators", "Operators"], ["/audit", "Audit log"]] as const;

export default function TowerLayout({ children }: { children: ReactNode }) {
  const router = useRouter(); const path = usePathname();
  const me = useApi<Me>("me");
  useEffect(() => {
    const out = () => router.replace(`/login?next=${encodeURIComponent(path)}`);
    window.addEventListener("tower:unauthenticated", out);
    return () => window.removeEventListener("tower:unauthenticated", out);
  }, [router, path]);
  if (me.error?.status === 401) return null; // redirecting
  if (me.error) {
    // Two different situations that must not be confused: the network can't reach the tower at all (status 0), or the tower answered with an error.
    const unreachable = me.error.status === 0;
    return (
      <main className="page">
        <h1>{unreachable ? "Can't reach the Control Tower" : "The Control Tower isn't ready"}</h1>
        <p className="lede">{me.error.message}</p>
        {me.error.requestId && <p className="muted">Reference: <span className="num">{me.error.requestId.slice(0, 8)}</span> — it appears in the server log next to the real reason.</p>}
        <Button onClick={() => void me.reload()}>Try again</Button>
      </main>
    );
  }
  if (!me.data) return <main className="page" aria-busy="true"><p className="muted">Opening the tower…</p></main>;
  const signOut = async () => { await call("logout", "POST", {}).catch(() => undefined); router.replace("/login"); };
  return (
    <Ctx.Provider value={me.data}>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <span className="brand">Control Tower</span>
        <nav className="topnav" aria-label="Main">{NAV.filter(([h]) => h !== "/operators" || canAdmin(me.data!)).map(([href, label]) => <Link key={href} href={href} aria-current={path.startsWith(href) ? "page" : undefined}>{label}</Link>)}</nav>
        <div className="who"><span>{me.data.name} · {me.data.role.replace("_", " ").toLowerCase()}</span><Button small variant="secondary" onClick={() => void signOut()}>Sign out</Button></div>
      </header>
      <div id="main">{children}</div>
    </Ctx.Provider>
  );
}

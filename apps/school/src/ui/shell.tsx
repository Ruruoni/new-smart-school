"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { NAV, PORTAL_TABS } from "@/lib/nav";
import { Icon } from "./icons";
import { cx, IconButton } from "./kit";
import { useSession } from "./session";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { OfflineBadge } from "./offline";

function Crest({ name, logo }: { name: string; logo: boolean }) {
  return logo
    ? /* eslint-disable-next-line @next/next/no-img-element */ <img src="/api/public/logo" alt="" className="size-10 rounded-md bg-white object-contain p-0.5" />
    : <span className="flex size-10 items-center justify-center rounded-md bg-brand-500 font-serif text-xl font-bold text-ink-950" aria-hidden>{name.trim()[0]?.toUpperCase()}</span>;
}

function Bell({ dark = false }: { dark?: boolean }) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(me.notifications);
  const [unread, setUnread] = useState(me.unreadNotifications);
  useEffect(() => { setList(me.notifications); setUnread(me.unreadNotifications); }, [me]);
  const markAll = async () => { await api.post("/notifications/read", { ids: "all" }).catch(() => undefined); setUnread(0); setList((l) => l.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))); };
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label={`Notifications, ${unread} unread`} aria-expanded={open} className={cx("relative inline-flex size-11 cursor-pointer items-center justify-center rounded-(--radius-ctl)", dark ? "text-white hover:bg-ink-800" : "text-ink-700 hover:bg-ink-100")}>
        <Icon name="bell" />
        {unread > 0 && <span className="num absolute top-1.5 right-1.5 min-w-5 rounded-full bg-pen-700 px-1 text-center text-xs font-bold text-white">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-(--radius-panel) border border-line bg-surface shadow-(--shadow-pop)">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5"><p className="font-serif font-semibold">Notifications</p>{unread > 0 && <button onClick={markAll} className="cursor-pointer text-sm font-bold text-brand-700 underline">Mark all as read</button>}</div>
          <ul className="max-h-80 overflow-y-auto">
            {list.length === 0 && <li className="px-4 py-6 text-center text-ink-500">Nothing new.</li>}
            {list.map((n) => (
              <li key={n.id} className={cx("border-b border-line px-4 py-3 last:border-0", !n.readAt && "bg-brand-50")}>
                <p className="font-bold">{n.title}</p><p className="text-[0.9375rem] text-ink-700">{n.body}</p><p className="mt-1 text-sm text-ink-500">{ago(n.createdAt)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function LicenseBanner() {
  const { me } = useSession();
  return (
    <>
      {me.license.message && me.license.status !== "ACTIVE" && (
        <div role="status" className={cx("no-print flex items-center gap-2 px-4 py-2 text-[0.9375rem] font-bold", me.license.mode === "FULL" ? "bg-amber-100 text-amber-700" : "bg-pen-100 text-pen-700")}>
          <Icon name="alert" size={18} />{me.license.message}
        </div>
      )}
      {me.banner && <div role="status" className="no-print flex items-center gap-2 bg-sky-100 px-4 py-2 text-[0.9375rem] font-bold text-sky-700"><Icon name="info" size={18} />{me.banner}</div>}
    </>
  );
}

/** Staff shell: dark slate rail (grouped by job), paper content area. */
export function StaffShell({ children }: { children: ReactNode }) {
  const { me, can, hasModule, signOut } = useSession();
  const path = usePathname();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [path]);

  const groups = NAV.map((g) => ({ ...g, items: g.items.filter((i) => can(...(i.perm ?? [])) && hasModule(i.module) && (!i.types || i.types.includes(me.user.userType))) })).filter((g) => g.items.length);
  const active = (href: string) => path === href || (href !== "/dashboard" && path.startsWith(`${href}/`));
  // the longest matching href wins so "Results" doesn't light up on "/results/scores"
  const best = groups.flatMap((g) => g.items).filter((i) => active(i.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;

  const rail = (
    <nav aria-label="Main" className="on-dark flex h-full flex-col bg-ink-900 text-ink-200">
      <div className="flex items-center gap-3 px-4 py-4"><Crest name={me.school.schoolName} logo={!!me.school.logoFileId} /><div className="min-w-0"><p className="truncate font-serif text-base leading-tight font-semibold text-white">{me.school.shortName ?? me.school.schoolName}</p><p className="text-sm text-ink-300">SmartSchool</p></div></div>
      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {groups.map((g) => (
          <div key={g.label} className="mt-3">
            <p className="px-3 pb-1 text-sm font-bold text-ink-400">{g.label}</p>
            <ul>
              {g.items.map((i) => (
                <li key={i.href}>
                  <Link href={i.href} aria-current={best === i.href ? "page" : undefined}
                    className={cx("flex min-h-11 items-center gap-3 rounded-md border-l-[3px] px-3 text-[0.9375rem] transition-colors", best === i.href ? "border-brand-500 bg-ink-800 font-bold text-white" : "border-transparent hover:bg-ink-800 hover:text-white")}>
                    <Icon name={i.icon} size={18} />{i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-ink-700 p-3">
        <p className="truncate px-2 text-[0.9375rem] font-bold text-white">{me.user.name}</p>
        <p className="px-2 pb-2 text-sm text-ink-300">{me.user.isPrimaryAdmin ? "Primary admin" : me.user.userType.toLowerCase().replace(/^./, (c) => c.toUpperCase())}</p>
        <button onClick={signOut} className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[0.9375rem] hover:bg-ink-800"><Icon name="logout" size={18} />Sign out</button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:font-bold">Skip to content</a>
      <aside className="no-print sticky top-0 hidden h-dvh lg:block">{rail}</aside>
      {drawer && <div className="fixed inset-0 z-50 lg:hidden"><button aria-label="Close menu" className="absolute inset-0 bg-ink-950/60" onClick={() => setDrawer(false)} /><div className="absolute inset-y-0 left-0 w-72 max-w-[85vw]">{rail}</div></div>}
      <div className="min-w-0">
        <header className="no-print sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur lg:px-6">
          <span className="lg:hidden"><IconButton icon="menu" label="Open menu" onClick={() => setDrawer(true)} /></span>
          <p className="flex-1 truncate font-serif text-lg font-semibold lg:hidden">{me.school.shortName ?? me.school.schoolName}</p>
          <div className="hidden flex-1 lg:block" />
          <OfflineBadge />
          <Bell />
        </header>
        <LicenseBanner />
        <main id="main" className="mx-auto max-w-[88rem] px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

/** Parent / student shell: mobile-first — compact header and a thumb-reachable bottom tab bar. */
export function PortalShell({ children, tabs = PORTAL_TABS, basePath = "/portal" }: { children: ReactNode; tabs?: typeof PORTAL_TABS; basePath?: string }) {
  const { me, signOut } = useSession();
  const path = usePathname();
  return (
    <div className="min-h-dvh bg-paper pb-20 md:pb-0">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:font-bold">Skip to content</a>
      <header className="on-dark sticky top-0 z-30 flex items-center gap-3 bg-ink-900 px-4 py-3 text-white">
        <Crest name={me.school.schoolName} logo={!!me.school.logoFileId} />
        <div className="min-w-0 flex-1"><p className="truncate font-serif text-lg leading-tight font-semibold">{me.school.shortName ?? me.school.schoolName}</p><p className="truncate text-sm text-ink-300">{me.user.name}</p></div>
        <OfflineBadge dark />
        <Bell dark />
        <button onClick={signOut} aria-label="Sign out" className="inline-flex size-11 cursor-pointer items-center justify-center rounded-md hover:bg-ink-800"><Icon name="logout" /></button>
      </header>
      <LicenseBanner />
      <nav aria-label="Sections" className="no-print fixed inset-x-0 bottom-0 z-40 grid border-t border-line bg-surface md:static md:z-auto md:mx-auto md:flex md:max-w-3xl md:justify-center md:gap-2 md:border-0 md:bg-transparent md:pt-4" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => {
          const on = t.href === basePath ? path === t.href : path.startsWith(t.href);
          return (
            <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined} className={cx("flex min-h-14 flex-col items-center justify-center gap-0.5 text-sm font-bold md:min-h-11 md:flex-row md:gap-2 md:rounded-full md:px-4", on ? "text-brand-800 md:bg-brand-100" : "text-ink-500 hover:text-ink-900")}>
              <Icon name={t.icon} size={22} />{t.label}
            </Link>
          );
        })}
      </nav>
      <main id="main" className="mx-auto max-w-3xl px-4 py-5">{children}</main>
    </div>
  );
}

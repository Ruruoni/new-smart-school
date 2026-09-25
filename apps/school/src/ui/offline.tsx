"use client";
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { cx } from "./kit";

/** Is the SCHOOL SERVER reachable (not the wider internet)? Checked with a cheap same-origin request. */
export function useServerReachable(): boolean {
  const [ok, setOk] = useState(true);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const r = await fetch("/api/health", { cache: "no-store" });
        if (alive) setOk(r.ok);
      } catch { if (alive) setOk(false); }
    };
    const t = setInterval(check, 20_000);
    const on = () => void check();
    window.addEventListener("online", on); window.addEventListener("offline", () => setOk(false));
    return () => { alive = false; clearInterval(t); window.removeEventListener("online", on); };
  }, []);
  return ok;
}

export function OfflineBadge({ dark }: { dark?: boolean }) {
  const ok = useServerReachable();
  if (ok) return null;
  return <span role="status" className={cx("inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold", dark ? "bg-amber-100 text-amber-700" : "bg-amber-100 text-amber-700")}><Icon name="cloudOff" size={16} />Server unreachable</span>;
}

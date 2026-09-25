"use client";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { date } from "@/lib/format";
import { DataState, Panel, Button } from "@/ui/kit";
import { Icon, type IconName } from "@/ui/icons";
import { useSession } from "@/ui/session";

const LINKS: { href: string; label: string; hint: string; icon: IconName; module?: string }[] = [
  { href: "/student/attendance", label: "My attendance", hint: "Days present, late and absent", icon: "check", module: "attendance" },
  { href: "/student/timetable", label: "My timetable", hint: "Lessons by day", icon: "calendar", module: "timetable" },
  { href: "/student/notes", label: "Lesson notes", hint: "Notes your teachers published", icon: "book", module: "lessonnotes" },
  { href: "/change-password", label: "Change my password", hint: "You'll sign in again afterwards", icon: "key" },
];

export default function StudentMore() {
  const { me, signOut, hasModule } = useSession();
  const ann = useApi<{ id: string; title: string; body: string; publishedAt: string | null }[]>("/announcements");
  return (
    <div className="space-y-5">
      <Panel title={me.user.name}><p className="text-ink-500">Signed in as <span className="num">{me.user.username}</span> at {me.school.schoolName}</p></Panel>
      <ul className="grid gap-3 sm:grid-cols-2">
        {LINKS.filter((l) => hasModule(l.module)).map((l) => (
          <li key={l.href}><Link href={l.href} className="flex min-h-16 items-center gap-3 rounded-(--radius-panel) border border-line bg-surface p-4 hover:border-brand-700">
            <Icon name={l.icon} size={22} className="shrink-0 text-brand-700" /><span><span className="block font-serif text-lg font-semibold">{l.label}</span><span className="block text-ink-500">{l.hint}</span></span>
          </Link></li>
        ))}
      </ul>
      <Panel title="Announcements"><DataState query={ann}>{(d) => d.length === 0 ? <p className="text-ink-500">None yet.</p> : <ul className="space-y-4">{d.map((a) => <li key={a.id}><p className="font-bold">{a.title}</p><p className="whitespace-pre-line text-ink-700">{a.body}</p>{a.publishedAt && <p className="text-sm text-ink-500">{date(a.publishedAt)}</p>}</li>)}</ul>}</DataState></Panel>
      <Button variant="secondary" className="w-full" onClick={signOut}>Sign out</Button>
    </div>
  );
}

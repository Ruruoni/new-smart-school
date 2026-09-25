"use client";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { date } from "@/lib/format";
import { DataState, Panel, Button } from "@/ui/kit";
import { ChildSelector, useChild } from "@/ui/children";
import { useSession } from "@/ui/session";

export default function More() {
  const { child } = useChild(); const { signOut, hasModule } = useSession();
  const ann = useApi<{ id: string; title: string; body: string; publishedAt: string | null }[]>("/announcements");
  const notes = useApi<{ items: { id: string; title: string; topic: string; subject: { name: string } }[] }>(child ? "/lesson-notes?pageSize=20" : null);
  return (
    <div className="space-y-5"><ChildSelector />
      <ul className="grid gap-3 sm:grid-cols-2">
        {hasModule("timetable") && <li><Link href="/portal/timetable" className="flex min-h-14 items-center rounded-(--radius-panel) border border-line bg-surface p-4 font-serif text-lg font-semibold hover:border-brand-700">Timetable</Link></li>}
        <li><Link href="/change-password" className="flex min-h-14 items-center rounded-(--radius-panel) border border-line bg-surface p-4 font-serif text-lg font-semibold hover:border-brand-700">Change my password</Link></li>
      </ul>
      <Panel title="Announcements"><DataState query={ann}>{(d) => d.length === 0 ? <p className="text-ink-500">None yet.</p> : <ul className="space-y-4">{d.map((a) => <li key={a.id}><p className="font-bold">{a.title}</p><p className="whitespace-pre-line text-ink-700">{a.body}</p><p className="text-sm text-ink-500">{date(a.publishedAt)}</p></li>)}</ul>}</DataState></Panel>
      <Panel title="Lesson notes" padded={false}><DataState query={notes}>{(d) => d.items.length === 0 ? <p className="p-4 text-ink-500">No notes published for your child's class yet.</p> : <ul className="divide-y divide-line">{d.items.map((n) => <li key={n.id}><Link className="block px-4 py-3 hover:bg-brand-50" href={`/portal/notes/${n.id}`}><p className="font-bold">{n.title}</p><p className="text-sm text-ink-500">{n.subject.name} · {n.topic}</p></Link></li>)}</ul>}</DataState></Panel>
      <Button variant="secondary" className="w-full" onClick={signOut}>Sign out</Button>
    </div>
  );
}

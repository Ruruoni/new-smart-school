"use client";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { DataState, EmptyState, Panel } from "@/ui/kit";

export default function StudentNotes() {
  const q = useApi<{ items: { id: string; title: string; topic: string; subject: { name: string } }[] }>("/lesson-notes?pageSize=50");
  return (<div className="space-y-4"><h1 className="font-serif text-2xl font-semibold">Lesson notes</h1><DataState query={q}>{(d) => d.items.length === 0 ? <Panel><EmptyState title="No notes yet" icon="book">Notes your teachers publish for your class appear here.</EmptyState></Panel> : <Panel padded={false}><ul className="divide-y divide-line">{d.items.map((n) => <li key={n.id}><Link className="block px-4 py-3 hover:bg-brand-50" href={`/portal/notes/${n.id}`}><p className="font-bold">{n.title}</p><p className="text-sm text-ink-500">{n.subject.name} · {n.topic}</p></Link></li>)}</ul></Panel>}</DataState></div>);
}

"use client";
import { use } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { DataState } from "@/ui/kit";

interface Note { title: string; topic: string; body: string; subject: { name: string }; attachments: { id: string; file: { id: string; originalName: string } }[] }

export default function ReadNote({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const q = useApi<Note>(`/lesson-notes/${id}`);
  return <DataState query={q}>{(n) => (<article className="space-y-4"><Link href="/portal/more" className="font-bold text-brand-700 underline">← Back</Link><header><p className="text-ink-500">{n.subject.name} · {n.topic}</p><h1 className="font-serif text-2xl font-semibold">{n.title}</h1></header><div className="max-w-[65ch] text-lg leading-relaxed whitespace-pre-line">{n.body}</div>{n.attachments.length > 0 && <ul className="space-y-1">{n.attachments.map((a) => <li key={a.id}><a className="font-bold text-brand-700 underline" href={`/api/files/${a.file.id}`}>{a.file.originalName}</a></li>)}</ul>}</article>)}</DataState>;
}

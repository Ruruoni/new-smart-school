"use client";
import { use } from "react";
import Link from "next/link";
import { useApi } from "@/lib/api";
import { DataState, Panel, Badge } from "@/ui/kit";

interface Res { exam: { title: string; kind: string }; resultAvailable: boolean; score?: number; totalMarks?: number; percentage?: number; passed?: boolean; message?: string; review: { number: number; stem: string; topic: string | null; explanation: string | null; outcome: string; selectedOptionIds: string[]; options: { id: string; label: string; text: string; isCorrect: boolean }[] }[] | null }

export default function ResultReview({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = use(params);
  const q = useApi<Res>(`/exam/attempts/${attemptId}/result`);
  return <DataState query={q}>{(r) => (
    <div className="space-y-5"><Link href="/student" className="font-bold text-brand-700 underline">← My exams</Link>
      <div><h1 className="font-serif text-2xl font-semibold">{r.exam.title}</h1>{r.resultAvailable ? <p className="num mt-1 text-lg"><strong className="font-serif text-4xl">{r.percentage}%</strong> · {r.score} of {r.totalMarks} marks · {r.passed ? "Pass" : "Below pass mark"}</p> : <p className="mt-2 text-ink-700">{r.message}</p>}</div>
      {r.review === null ? (r.resultAvailable && <p className="text-ink-500">Your teacher has chosen not to show the answer key for this exam.</p>) : (
        <ol className="space-y-4">{r.review.map((x) => (
          <li key={x.number}><Panel><div className="mb-2 flex items-center justify-between"><p className="num font-bold">Question {x.number}</p><Badge tone={x.outcome === "CORRECT" ? "ok" : x.outcome === "WRONG" ? "bad" : "warn"}>{x.outcome === "CORRECT" ? "Correct" : x.outcome === "WRONG" ? "Wrong" : "Not answered"}</Badge></div>
            <p className="whitespace-pre-line text-lg">{x.stem}</p>
            <ul className="mt-3 space-y-2">{x.options.map((o) => { const mine = x.selectedOptionIds.includes(o.id); return <li key={o.id} className={`flex gap-3 rounded-md border-2 px-3 py-2 ${o.isCorrect ? "border-leaf-700 bg-leaf-100" : mine ? "border-pen-700 bg-pen-100" : "border-line"}`}><strong className="num">{o.label}</strong><span>{o.text}{o.isCorrect && <span className="ml-2 font-bold text-leaf-700">✓ correct</span>}{mine && !o.isCorrect && <span className="ml-2 font-bold text-pen-700">your answer</span>}</span></li>; })}</ul>
            {x.explanation && <p className="mt-3 rounded bg-paper p-3 text-ink-800"><strong>Why: </strong>{x.explanation}</p>}</Panel></li>
        ))}</ol>)}
    </div>
  )}</DataState>;
}

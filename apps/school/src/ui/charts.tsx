"use client";
import { cx } from "./kit";

/** Horizontal bars as a real table underneath (screen readers get the data; colour is never the only encoding). */
export function Bars({ data, format = (v: number) => String(v), max, tone = "brand" }: { data: { label: string; value: number }[]; format?: (v: number) => string; max?: number; tone?: "brand" | "bad" }) {
  const top = max ?? Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <p className="text-ink-500">No data yet.</p>;
  return (
    <ul className="space-y-2" role="list">
      {data.map((d) => (
        <li key={d.label} className="grid grid-cols-[minmax(4rem,9rem)_1fr_auto] items-center gap-3">
          <span className="truncate text-[0.9375rem]" title={d.label}>{d.label}</span>
          <div className="h-3 rounded bg-ink-100" aria-hidden><div className={cx("h-3 rounded", tone === "bad" ? "bg-pen-700" : "bg-brand-700")} style={{ width: `${Math.min(100, (d.value / top) * 100)}%` }} /></div>
          <span className="num text-[0.9375rem] font-bold">{format(d.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Small accessible line chart (inline SVG) with a data table alternative. */
export function Line({ data, format = (v: number) => String(v) }: { data: { label: string; value: number }[]; format?: (v: number) => string }) {
  if (!data.length) return <p className="text-ink-500">No data yet.</p>;
  const W = 560, H = 180, P = 28;
  const max = Math.max(1, ...data.map((d) => d.value)), min = Math.min(0, ...data.map((d) => d.value));
  const x = (i: number) => P + (data.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (data.length - 1));
  const y = (v: number) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const path = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Trend: ${data.map((d) => `${d.label} ${format(d.value)}`).join(", ")}`} className="w-full">
        <line x1={P} x2={W - P} y1={H - P} y2={H - P} stroke="var(--color-ink-200)" />
        <path d={path} fill="none" stroke="var(--color-brand-700)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => <g key={d.label + i}><circle cx={x(i)} cy={y(d.value)} r="4" fill="var(--color-brand-700)" />{(data.length <= 8 || i % Math.ceil(data.length / 8) === 0) && <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--color-ink-500)">{d.label}</text>}</g>)}
      </svg>
      <details className="mt-1 text-sm text-ink-500"><summary className="cursor-pointer">View as table</summary><table className="register compact mt-2"><tbody>{data.map((d, i) => <tr key={i}><td>{d.label}</td><td className="right num">{format(d.value)}</td></tr>)}</tbody></table></details>
    </div>
  );
}

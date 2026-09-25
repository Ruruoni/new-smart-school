"use client";
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

export function Button({ variant, small, loading, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "secondary" | "danger"; small?: boolean; loading?: boolean }) {
  return <button type="button" {...p} disabled={p.disabled || loading} aria-busy={loading || undefined} className={`btn ${variant ?? ""} ${small ? "small" : ""} ${p.className ?? ""}`}>{loading ? "Working…" : children}</button>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export const TextInput = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={`input ${p.className ?? ""}`} />;
export const TextArea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={`input ${p.className ?? ""}`} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={`input ${p.className ?? ""}`} />;

export const Notice = ({ tone = "info", children }: { tone?: "bad" | "ok" | "info"; children: ReactNode }) => <p role={tone === "bad" ? "alert" : "status"} className={`notice ${tone}`}>{children}</p>;
export const Badge = ({ tone, children }: { tone?: "ok" | "warn" | "bad" | "violet"; children: ReactNode }) => <span className={`badge ${tone ?? ""}`}>{children}</span>;

/** Native <dialog>: focus is trapped, Escape closes, and focus returns to the trigger. */
export function Dialog({ open, title, onClose, footer, children }: { open: boolean; title: string; onClose: () => void; footer?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={id} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      {open && <><div className="dhead"><h2 id={id} style={{ fontSize: "1.25rem" }}>{title}</h2><Button variant="secondary" small aria-label="Close" onClick={onClose}>Close</Button></div><div className="dbody">{children}</div>{footer && <div className="dfoot">{footer}</div>}</>}
    </dialog>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "ok" | "warn" | "bad"; hint?: string }) {
  return <div className={`kpi ${tone ?? ""}`} title={hint}><dt>{label}</dt><dd>{value}</dd></div>;
}

"use client";
import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Icon, type IconName } from "./icons";
import { ApiError } from "@/lib/api";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ───────────── Buttons ─────────────
type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANT: Record<Variant, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-800 active:bg-brand-900 disabled:bg-ink-300",
  secondary: "bg-surface text-ink-800 border border-ink-300 hover:bg-ink-100 hover:border-ink-400 disabled:text-ink-400",
  ghost: "bg-transparent text-ink-700 hover:bg-ink-100 disabled:text-ink-400",
  danger: "bg-pen-700 text-white hover:bg-[#8f1b12] disabled:bg-ink-300",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: IconName;
  loading?: boolean;
  size?: "md" | "sm";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "primary", icon, loading, size = "md", className, children, disabled, type = "button", ...rest }, ref) {
  return (
    <button
      ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cx("inline-flex items-center justify-center gap-2 rounded-(--radius-ctl) font-bold transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed select-none", size === "md" ? "min-h-11 px-4 text-base" : "min-h-9 px-3 text-[0.9375rem]", VARIANT[variant], className)}
      {...rest}
    >
      {loading ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden /> : icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  );
});

export function IconButton({ icon, label, ...rest }: { icon: IconName; label: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" aria-label={label} title={label} className="inline-flex size-11 items-center justify-center rounded-(--radius-ctl) text-ink-700 transition-colors hover:bg-ink-100 cursor-pointer disabled:text-ink-300" {...rest}>
      <Icon name={icon} />
    </button>
  );
}

// ───────────── Form controls ─────────────
const CONTROL = "block w-full min-h-11 rounded-(--radius-ctl) border border-ink-300 bg-surface px-3 text-base text-ink-900 placeholder:text-ink-400 transition-colors hover:border-ink-400 focus:border-brand-700 disabled:bg-ink-100 disabled:text-ink-500 aria-[invalid=true]:border-pen-700";

export function Field({ label, error, hint, children, htmlFor, required, className }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor?: string; required?: boolean; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[0.9375rem] font-bold text-ink-800">
        {label}{required && <span className="text-pen-700" aria-hidden> *</span>}
      </label>
      {children}
      {hint && !error && <p className="text-sm text-ink-500">{hint}</p>}
      {error && <p role="alert" className="flex items-center gap-1.5 text-sm font-bold text-pen-700"><Icon name="alert" size={16} />{error}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={cx(CONTROL, className)} {...rest} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select({ className, invalid, children, ...rest }, ref) {
  return <select ref={ref} aria-invalid={invalid || undefined} className={cx(CONTROL, "pr-8", className)} {...rest}>{children}</select>;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, ...rest }, ref) {
  return <textarea ref={ref} aria-invalid={invalid || undefined} className={cx(CONTROL, "py-2 min-h-24", className)} {...rest} />;
});

/** Labelled input in one line: <TextField label="…" value onChange error /> */
export function TextField({ label, error, hint, required, className, ...rest }: { label: string; error?: string; hint?: string; required?: boolean; className?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return <Field label={label} error={error} hint={hint} required={required} htmlFor={id} className={className}><Input id={id} invalid={!!error} required={required} {...rest} /></Field>;
}

export function SelectField({ label, error, hint, required, className, children, ...rest }: { label: string; error?: string; hint?: string; required?: boolean; className?: string } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return <Field label={label} error={error} hint={hint} required={required} htmlFor={id} className={className}><Select id={id} invalid={!!error} required={required} {...rest}>{children}</Select></Field>;
}

export function Checkbox({ label, hint, ...rest }: { label: string; hint?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" className="mt-1 size-5 shrink-0 cursor-pointer accent-brand-700" {...rest} />
      <label htmlFor={id} className="cursor-pointer text-base text-ink-800">{label}{hint && <span className="block text-sm text-ink-500">{hint}</span>}</label>
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx("relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50", checked ? "bg-brand-700" : "bg-ink-300")}>
      <span className={cx("inline-block size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-6" : "translate-x-1")} />
    </button>
  );
}

// ───────────── Status ─────────────
type Tone = "neutral" | "ok" | "warn" | "bad" | "info" | "brand";
const TONE: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-700", ok: "bg-leaf-100 text-leaf-700", warn: "bg-amber-100 text-amber-700",
  bad: "bg-pen-100 text-pen-700", info: "bg-sky-100 text-sky-700", brand: "bg-brand-100 text-brand-800",
};
export function Badge({ tone = "neutral", children, icon }: { tone?: Tone; children: ReactNode; icon?: IconName }) {
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-bold whitespace-nowrap", TONE[tone])}>{icon && <Icon name={icon} size={14} />}{children}</span>;
}

/** Map any status word to a tone (colour is never the only signal: the word is always shown). */
export function StatusBadge({ status }: { status: string }) {
  const s = status.toUpperCase();
  const tone: Tone = ["ACTIVE", "PAID", "PUBLISHED", "SUCCEEDED", "SENT", "PRESENT", "APPROVED", "ENROLLED", "OPEN", "VERIFIED", "COMPLETED", "ACKED", "RESOLVED", "OK", "GRADUATED"].includes(s) ? "ok"
    : ["PENDING", "QUEUED", "DRAFT", "PARTIALLY_PAID", "LATE", "UNDER_REVIEW", "SCHEDULED", "IN_PROGRESS", "GRACE", "PREVIEW", "RUNNING", "IN_FLIGHT", "SUBMITTED", "TRIAL", "SENDING"].includes(s) ? "warn"
    : ["OVERDUE", "ABSENT", "REJECTED", "FAILED", "DEAD", "VOID", "REVERSED", "SUSPENDED", "DISABLED", "WITHDRAWN", "EXPIRED", "CONFLICT", "TRIAL_EXPIRED", "CRITICAL", "CLOSED", "CANCELLED"].includes(s) ? "bad"
    : ["EXCUSED", "TRANSFERRED", "ISSUED", "UPLOADED", "INFO"].includes(s) ? "info" : "neutral";
  return <Badge tone={tone}>{status.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase())}</Badge>;
}

// ───────────── Layout blocks ─────────────
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink-900 pb-4">
      <div className="min-w-0">
        <h1 className="font-serif text-[1.75rem] leading-tight font-semibold text-ink-900 sm:text-[2rem]">{title}</h1>
        {description && <p className="mt-1 max-w-[65ch] text-ink-500">{description}</p>}
      </div>
      {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ title, actions, children, className, padded = true }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx("rounded-(--radius-panel) border border-line bg-surface", className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          {title && <h2 className="font-serif text-lg font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "bad" | "ok" | "warn" }) {
  return (
    <div className={cx("rounded-(--radius-panel) border border-line bg-surface p-4 border-l-[3px]", tone === "bad" ? "border-l-pen-700" : tone === "ok" ? "border-l-leaf-700" : tone === "warn" ? "border-l-[#d98a00]" : "border-l-brand-700")}>
      <p className="text-[0.9375rem] text-ink-500">{label}</p>
      <p className="num mt-1 font-serif text-3xl font-semibold text-ink-900">{value}</p>
      {note && <p className="mt-1 text-sm text-ink-500">{note}</p>}
    </div>
  );
}

export function EmptyState({ title, children, action, icon = "info" }: { title: string; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Icon name={icon} size={24} /></span>
      <h3 className="font-serif text-lg font-semibold">{title}</h3>
      {children && <p className="max-w-[50ch] text-ink-500">{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded bg-ink-100", className)} aria-hidden />;
}

export function ErrorNote({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null;
  const forbidden = error instanceof ApiError && error.status === 403;
  return (
    <div role="alert" className="flex flex-wrap items-start gap-3 rounded-(--radius-panel) border border-pen-700/40 bg-pen-100 p-4 text-pen-700">
      <Icon name="alert" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-bold">{forbidden ? "You don't have access to this" : error instanceof ApiError && error.code === "NETWORK" ? "You're offline" : error instanceof ApiError && error.status >= 500 ? "The school server isn't ready" : "That didn't work"}</p>
        <p className="text-ink-800">{error.message}</p>
        {error instanceof ApiError && error.requestId && <p className="mt-1 text-sm text-ink-500">Reference: {error.requestId.slice(0, 8)}</p>}
        {onRetry && <Button variant="secondary" size="sm" icon="refresh" className="mt-3" onClick={onRetry}>Try again</Button>}
      </div>
    </div>
  );
}

/** Standard loading / error / content switch so every screen behaves the same way. */
export function DataState<T>({ query, children, empty }: { query: { data: T | undefined; error: ApiError | null; loading: boolean; reload: () => void }; children: (d: T) => ReactNode; empty?: (d: T) => boolean }) {
  if (query.error && query.data === undefined) return <ErrorNote error={query.error} onRetry={query.reload} />;
  if (query.data === undefined) return <div className="space-y-3" aria-busy="true" aria-live="polite"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-3/4" /><span className="sr-only">Loading</span></div>;
  if (empty?.(query.data)) return null;
  return <>{children(query.data)}</>;
}

// ───────────── Tabs ─────────────
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string; badge?: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault(); onChange(tabs[next]!.id); refs.current[tabs[next]!.id]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="no-print mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t, i) => (
        <button key={t.id} ref={(el) => { refs.current[t.id] = el; }} role="tab" id={`tab-${t.id}`} aria-selected={value === t.id} aria-controls={`panel-${t.id}`} tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}
          className={cx("-mb-px flex min-h-11 shrink-0 cursor-pointer items-center gap-2 border-b-[3px] px-4 font-bold transition-colors", value === t.id ? "border-brand-700 text-brand-800" : "border-transparent text-ink-500 hover:text-ink-900")}>
          {t.label}{t.badge}
        </button>
      ))}
    </div>
  );
}
export const TabPanel = ({ id, active, children }: { id: string; active: boolean; children: ReactNode }) => (active ? <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`}>{children}</div> : null);

// ───────────── Dialog (native <dialog>: focus trap, Esc, inert background) ─────────────
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cx("m-auto w-[calc(100%-2rem)] rounded-(--radius-panel) bg-surface p-0 text-ink-900 shadow-(--shadow-pop) backdrop:bg-ink-950/60", wide ? "max-w-3xl" : "max-w-lg")}>
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
            <h2 id={titleId} className="font-serif text-xl font-semibold">{title}</h2>
            <IconButton icon="x" label="Close" onClick={onClose} />
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-paper px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ───────────── Toasts ─────────────
interface ToastItem { id: number; tone: "ok" | "bad" | "info"; text: string }
const ToastCtx = createContext<{ push: (tone: ToastItem["tone"], text: string) => void }>({ push: () => undefined });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((tone: ToastItem["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), tone === "bad" ? 8000 : 4000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="no-print fixed bottom-4 left-1/2 z-[100] flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col gap-2" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx("flex items-start gap-3 rounded-(--radius-panel) px-4 py-3 text-white shadow-(--shadow-pop)", t.tone === "ok" ? "bg-leaf-700" : t.tone === "bad" ? "bg-pen-700" : "bg-ink-800")}>
            <Icon name={t.tone === "ok" ? "check" : t.tone === "bad" ? "alert" : "info"} className="mt-0.5 shrink-0" />
            <p className="font-bold">{t.text}</p>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ───────────── Confirm ─────────────
export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onClose, pending, children }: { open: boolean; title: string; body?: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void; pending?: boolean; children?: ReactNode }) {
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={danger ? "danger" : "primary"} loading={pending} onClick={onConfirm}>{confirmLabel}</Button></>}>
      {body && <p className="text-ink-700">{body}</p>}
      {children}
    </Dialog>
  );
}

// ───────────── Pagination & search ─────────────
export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return <p className="no-print mt-3 text-sm text-ink-500">{total} {total === 1 ? "record" : "records"}</p>;
  return (
    <nav aria-label="Pagination" className="no-print mt-3 flex flex-wrap items-center justify-between gap-3 text-[0.9375rem]">
      <p className="num text-ink-500">{(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total}</p>
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" icon="chevronLeft" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <span className="num px-2">Page {page} of {pages}</span>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next<Icon name="chevronRight" size={18} /></Button>
      </div>
    </nav>
  );
}

export function SearchBox({ value, onChange, placeholder = "Search", label = "Search" }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => { const t = setTimeout(() => local !== value && onChange(local), 300); return () => clearTimeout(t); }, [local, value, onChange]);
  return (
    <div className="relative min-w-56 flex-1 sm:max-w-sm">
      <Icon name="search" size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-400" />
      <input type="search" aria-label={label} value={local} onChange={(e) => setLocal(e.target.value)} placeholder={placeholder} className={cx(CONTROL, "pl-10")} />
    </div>
  );
}

export function FormError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-(--radius-ctl) border border-pen-700/40 bg-pen-100 px-3 py-2 text-pen-700">
      <p className="font-bold">{error.message}</p>
      {error.requestId && <p className="mt-0.5 text-sm font-normal text-ink-700">Reference: <span className="num">{error.requestId.slice(0, 8)}</span> — quote this if you ask for help.</p>}
    </div>
  );
}

const naira = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2 });
const nairaWhole = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 });
export const money = (v: number | string | null | undefined, whole = false) => (v === null || v === undefined || v === "" ? "—" : (whole ? nairaWhole : naira).format(Number(v)));
export const int = (v: number | null | undefined) => (v === null || v === undefined ? "—" : new Intl.NumberFormat("en-NG").format(v));
export const pct = (v: number | string | null | undefined, digits = 1) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(digits)}%`);

export function date(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}
export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
export function ago(v: string | Date | null | undefined): string {
  if (!v) return "never";
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
export const fullName = (p: { firstName: string; lastName: string; middleName?: string | null }) => `${p.firstName} ${p.lastName}`;
export const ordinal = (n: number) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`; };
export const humanize = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

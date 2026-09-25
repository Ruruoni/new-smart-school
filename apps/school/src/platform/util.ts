import { z } from "zod";
import { staleWrite, notFound } from "./errors";

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(100).optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Paging from a query string, clamped to sane bounds: garbage, zero, negative or enormous values fall back instead of reaching the database. */
export function pageParams(query: URLSearchParams, defaultSize = 25) {
  const p = Number.parseInt(query.get("page") ?? "", 10), s = Number.parseInt(query.get("pageSize") ?? "", 10);
  return { page: Number.isFinite(p) && p >= 1 && p <= 100_000 ? p : 1, pageSize: Number.isFinite(s) ? Math.min(200, Math.max(1, s)) : defaultSize };
}

export const skipTake = (p: { page: number; pageSize: number }) => ({ skip: (p.page - 1) * p.pageSize, take: p.pageSize });
export const asPage = <T>(items: T[], total: number, p: { page: number; pageSize: number }): Page<T> => ({ items, total, page: p.page, pageSize: p.pageSize });

/**
 * Optimistic concurrency: `updateMany({ where: { id, version } })` returns a count; 0 means either the row is
 * gone or someone changed it first. Never silently overwrite.
 */
export function assertUpdated(count: number, entity: string, currentVersion?: number): void {
  if (count === 1) return;
  if (currentVersion === undefined) throw notFound(entity);
  throw staleWrite(entity, currentVersion);
}

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
/** A plausible date of birth: a real calendar date, not in the future, not more than 40 years ago. */
export const birthDate = isoDate.refine((s) => {
  const d = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(d)) return false;
  const now = Date.now();
  return d <= now && now - d <= 40 * 365.25 * 86_400_000;
}, "Enter a real date of birth (not in the future)");
export const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const money = z.coerce.number().finite().min(0).max(1_000_000_000).transform((n) => Math.round(n * 100) / 100);

export const ilike = (q: string | undefined) => (q ? { contains: q, mode: "insensitive" as const } : undefined);

/**
 * Dotted-path lookup that only follows OWN properties. Plain `obj[key]` walks the prototype chain, so a
 * user-editable path like "constructor" or "__proto__.x" would leak runtime internals.
 */
export function safeGet(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

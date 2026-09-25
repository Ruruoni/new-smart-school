/**
 * Diagnostics shared by the school app and the Control Tower: recognising infrastructure failures for what they are, and
 * keeping credentials out of logs. Pure functions (no dependencies) so both apps behave identically.
 */

/** Remove credentials from anything about to be logged (connection strings, key=value secrets). */
export function redactSecrets(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, "$1<redacted>@")
    .replace(/((?:password|secret|token|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1<redacted>");
}

export type InfrastructureCode = "DATABASE_UNAVAILABLE" | "DATABASE_MISCONFIGURED" | "DATABASE_NOT_MIGRATED";

export const INFRASTRUCTURE_MESSAGES: Record<InfrastructureCode, string> = {
  DATABASE_MISCONFIGURED: "The server can't use its database because the database settings are wrong. Please tell whoever installed the server to check the server's log.",
  DATABASE_NOT_MIGRATED: "The database hasn't been fully set up yet (its migrations haven't been applied). Please tell whoever installed the server.",
  DATABASE_UNAVAILABLE: "The database can't be reached right now. Please try again in a minute; if this keeps happening, tell whoever looks after the server.",
};

/**
 * Matches the shapes Prisma and the pg driver actually throw, captured from real failures:
 * P1000 bad credentials · P1003 database missing · P2021/P2022 table/column missing (migrations not applied) ·
 * P1001/P1002/P1008/P1017/P2024 unreachable or timed out · and a plain `Error("Connection terminated due to connection timeout")`
 * for an unresolvable host (e.g. a container name on Docker's default bridge network, which has no name resolution).
 */
export function classifyInfrastructureError(err: unknown): { code: InfrastructureCode; message: string } | null {
  const e = err as { code?: string; name?: string; message?: string; meta?: { code?: string } } | null;
  const code = e?.code ?? "";
  // A raw query that hit a missing table/column carries PostgreSQL's own code (directly from pg, or as Prisma's meta.code).
  const pgCode = /^\d{2}[0-9A-Z]{3}$/.test(code) ? code : e?.meta?.code ?? "";
  const text = String(e?.message ?? "");
  const hit = (c: InfrastructureCode) => ({ code: c, message: INFRASTRUCTURE_MESSAGES[c] });
  if (["P1000", "P1003", "P1010"].includes(code)) return hit("DATABASE_MISCONFIGURED");
  // Judged by the driver's error CODE, never by the words in a message: an ordinary bug in our own code that happens to say
  // "relation … does not exist" must not be reported to users as "the database hasn't been set up".
  if (["P2021", "P2022"].includes(code) || ["42P01", "42703"].includes(pgCode)) return hit("DATABASE_NOT_MIGRATED");
  if (["P1001", "P1002", "P1008", "P1017", "P2024"].includes(code) || e?.name === "PrismaClientInitializationError" || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Connection terminated|connection timeout|the database system is (starting up|shutting down)/i.test(text)) return hit("DATABASE_UNAVAILABLE");
  return null;
}

/**
 * Should the session cookie carry the `Secure` flag for this request?
 *  "true"  → always (HTTPS deployments that terminate TLS themselves)
 *  "false" → never  (plain-HTTP LAN)
 *  "auto"  → only if this request arrived over HTTPS, directly or through a proxy that says so (X-Forwarded-Proto).
 * A fixed setting is a trap either way: `Secure` cookies are silently dropped by browsers on plain HTTP (except localhost), which
 * looks exactly like "login succeeds but I'm not signed in"; and no `Secure` flag over HTTPS is a weaker session cookie.
 */
export function cookieShouldBeSecure(mode: string | undefined, req: { url: string; headers: Headers }): boolean {
  if (mode === "true") return true;
  if (mode === "false") return false;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  try { return new URL(req.url).protocol === "https:"; } catch { return false; }
}

import { safeGet } from "@/platform/util";

/** Rule conditions: a small, safe expression model (no eval). All conditions in a rule must hold. */
export type Op = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "contains" | "exists";

export interface Condition {
  field: string; // dotted path into { event: { type }, payload: {...} }
  op: Op;
  value?: unknown;
}

export const getPath = safeGet;

const asNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export function evalCondition(c: Condition, ctx: Record<string, unknown>): boolean {
  const actual = getPath(ctx, c.field);
  switch (c.op) {
    case "exists": return actual !== undefined && actual !== null;
    case "=": return String(actual) === String(c.value);
    case "!=": return String(actual) !== String(c.value);
    case ">": case ">=": case "<": case "<=": {
      const a = asNumber(actual), b = asNumber(c.value);
      if (a === null || b === null) return false; // a missing value never satisfies a numeric comparison
      return c.op === ">" ? a > b : c.op === ">=" ? a >= b : c.op === "<" ? a < b : a <= b;
    }
    case "in": return Array.isArray(c.value) && c.value.map(String).includes(String(actual));
    case "contains": return typeof actual === "string" ? actual.toLowerCase().includes(String(c.value ?? "").toLowerCase()) : Array.isArray(actual) && actual.map(String).includes(String(c.value));
    default: return false;
  }
}

export function evalAll(conditions: readonly Condition[], ctx: Record<string, unknown>): { ok: boolean; failed: Condition | null } {
  for (const c of conditions) if (!evalCondition(c, ctx)) return { ok: false, failed: c };
  return { ok: true, failed: null };
}

const OPS = new Set<string>(["=", "!=", ">", ">=", "<", "<=", "in", "contains", "exists"]);
export function validateConditions(input: unknown): Condition[] {
  if (!Array.isArray(input)) throw new Error("Conditions must be a list");
  return input.map((c, i) => {
    if (!c || typeof c !== "object") throw new Error(`Condition ${i + 1} is invalid`);
    const { field, op, value } = c as Record<string, unknown>;
    if (typeof field !== "string" || !/^[a-zA-Z0-9_.]+$/.test(field)) throw new Error(`Condition ${i + 1}: invalid field`);
    if (typeof op !== "string" || !OPS.has(op)) throw new Error(`Condition ${i + 1}: unknown operator`);
    return { field, op: op as Op, value };
  });
}

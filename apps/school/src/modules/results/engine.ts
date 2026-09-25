/**
 * Pure result-processing logic. No I/O: every rule here is unit-tested and the same functions serve the
 * teacher score sheet, the processing run, report cards, CBT-to-CA imports and analytics.
 * All arithmetic is done in integer hundredths to avoid floating-point drift on scores like 12.35.
 */
export interface GradeBand {
  grade: string;
  minScore: number;
  maxScore: number;
  remark?: string | null;
  gradePoint?: number | null;
  isPass: boolean;
}

export interface Component {
  id: string;
  code: string;
  maxScore: number;
  isExam: boolean;
}

export interface ScoreEntry {
  score: number | null;
  isAbsent: boolean;
}

/** Round half up to 2dp using decimal-string exponent shifting (1.005 → 1.01, which n*100 cannot do). */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return n;
  const s = n.toString();
  if (s.includes("e")) return Number(n.toFixed(2)); // tiny/huge magnitudes: exponent form
  return Number(`${Math.round(Number(`${s}e2`))}e-2`);
}

const c = (n: number) => Math.round(Number(`${round2(n)}e2`)); // to integer hundredths
const f = (h: number) => h / 100;

export function gradeFor(percentage: number, bands: readonly GradeBand[]): GradeBand | null {
  const p = round2(percentage);
  // Highest band whose minimum the score reaches; tolerant of gaps between bands (e.g. 74.5 vs 75).
  const sorted = [...bands].sort((a, b) => b.minScore - a.minScore);
  return sorted.find((b) => p >= b.minScore) ?? null;
}

export function validateBands(bands: readonly GradeBand[]): string[] {
  const problems: string[] = [];
  if (!bands.length) return ["At least one grade band is required"];
  const sorted = [...bands].sort((a, b) => a.minScore - b.minScore);
  if (sorted[0]!.minScore > 0) problems.push("Bands must start at 0");
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]!;
    if (b.minScore > b.maxScore) problems.push(`${b.grade}: min is above max`);
    const next = sorted[i + 1];
    if (next && next.minScore <= b.maxScore) problems.push(`${b.grade} overlaps ${next.grade}`);
  }
  if (sorted[sorted.length - 1]!.maxScore < 100) problems.push("Bands must reach 100");
  return problems;
}

export function validateComponents(components: readonly Component[]): string[] {
  const total = components.reduce((s, x) => s + c(x.maxScore), 0);
  const problems: string[] = [];
  if (total !== 10000) problems.push(`Component maximum scores must add up to 100 (currently ${f(total)})`);
  if (components.filter((x) => x.isExam).length !== 1) problems.push("Exactly one component must be the examination");
  return problems;
}

export interface SubjectComputation {
  caTotal: number;
  examScore: number;
  total: number;
  percentage: number;
  /** Components with no score recorded (treated as 0 but reported so teachers can fix them). */
  missing: string[];
  breakdown: Record<string, number | null>;
}

export function computeSubject(components: readonly Component[], scores: ReadonlyMap<string, ScoreEntry>): SubjectComputation {
  let ca = 0;
  let exam = 0;
  const missing: string[] = [];
  const breakdown: Record<string, number | null> = {};
  for (const comp of components) {
    const e = scores.get(comp.id);
    const val = e && !e.isAbsent && e.score !== null ? c(Math.min(e.score, comp.maxScore)) : 0;
    if (!e || (e.score === null && !e.isAbsent)) missing.push(comp.code);
    breakdown[comp.code] = e && e.score !== null ? e.score : e?.isAbsent ? 0 : null;
    if (comp.isExam) exam += val;
    else ca += val;
  }
  const maxTotal = components.reduce((s, x) => s + c(x.maxScore), 0) || 10000;
  const total = ca + exam;
  return { caTotal: f(ca), examScore: f(exam), total: f(total), percentage: round2((total / maxTotal) * 100), missing, breakdown };
}

export type PositionMethod = "STANDARD_COMPETITION" | "DENSE";

/**
 * Rank by descending value. STANDARD_COMPETITION: 1,2,2,4 (ties share a rank, next rank skips).
 * DENSE: 1,2,2,3. Values are compared in hundredths so 70.10 and 70.1 tie.
 */
export function rank<T extends { id: string; value: number }>(items: readonly T[], method: PositionMethod = "STANDARD_COMPETITION"): Map<string, number> {
  const sorted = [...items].sort((a, b) => c(b.value) - c(a.value) || a.id.localeCompare(b.id));
  const out = new Map<string, number>();
  let position = 0;
  let prev: number | null = null;
  let dense = 0;
  sorted.forEach((it, idx) => {
    const v = c(it.value);
    if (prev === null || v !== prev) {
      dense += 1;
      position = method === "DENSE" ? dense : idx + 1;
      prev = v;
    }
    out.set(it.id, position);
  });
  return out;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export const average = (values: readonly number[]) => (values.length ? round2(values.reduce((s, v) => s + c(v), 0) / values.length / 100) : 0);

export interface CumulativeInput {
  termAverages: readonly number[]; // published/processed averages for terms up to and including the current one
}
export const cumulativeAverage = ({ termAverages }: CumulativeInput) => average(termAverages);

export type Decision = "PROMOTED" | "REPEATED" | "GRADUATED";

export interface PromotionInput {
  average: number;
  minimumAverage: number;
  isTerminalClass: boolean;
  /** Optional: fail if any of these subject ids scored a failing grade. */
  failedCoreSubjects?: number;
  maxFailedCore?: number;
}

export function decidePromotion(i: PromotionInput): { decision: Decision; reason: string } {
  const failedCore = i.failedCoreSubjects ?? 0;
  const ok = i.average >= i.minimumAverage && (i.maxFailedCore === undefined || failedCore <= i.maxFailedCore);
  if (!ok) {
    const why = i.average < i.minimumAverage ? `average ${i.average} is below ${i.minimumAverage}` : `${failedCore} core subject(s) failed`;
    return { decision: "REPEATED", reason: `Does not meet promotion criteria: ${why}` };
  }
  return i.isTerminalClass ? { decision: "GRADUATED", reason: "Completed the final class" } : { decision: "PROMOTED", reason: `Average ${i.average} meets ${i.minimumAverage}` };
}

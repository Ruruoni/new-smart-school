/** Pure CBT scoring, exam paper assembly and analytics maths — no I/O, fully unit-tested. */

export interface ScorableQuestion {
  examQuestionId: string;
  marks: number;
  topicId: string | null;
  correctOptionIds: readonly string[];
}

export interface GivenAnswer {
  examQuestionId: string;
  selectedOptionIds: readonly string[];
}

export interface ScoreOutcome {
  score: number;
  totalMarks: number;
  percentage: number;
  correctCount: number;
  wrongCount: number;
  unansweredCount: number;
  perQuestion: Record<string, "CORRECT" | "WRONG" | "UNANSWERED">;
  byTopic: Record<string, { attempted: number; correct: number }>;
}

const hundredths = (n: number) => Math.round(n * 100);

/** All-or-nothing per question: the selected set must equal the correct set (also covers multi-select). */
export function isCorrect(selected: readonly string[], correct: readonly string[]): boolean {
  if (!selected.length || selected.length !== new Set(selected).size) return false;
  if (selected.length !== correct.length) return false;
  const c = new Set(correct);
  return selected.every((s) => c.has(s));
}

export function scoreAttempt(questions: readonly ScorableQuestion[], answers: readonly GivenAnswer[]): ScoreOutcome {
  const byQ = new Map(answers.map((a) => [a.examQuestionId, a.selectedOptionIds]));
  let score = 0;
  let total = 0;
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  const perQuestion: ScoreOutcome["perQuestion"] = {};
  const byTopic: ScoreOutcome["byTopic"] = {};
  for (const q of questions) {
    total += hundredths(q.marks);
    const sel = byQ.get(q.examQuestionId) ?? [];
    let outcome: "CORRECT" | "WRONG" | "UNANSWERED";
    if (!sel.length) { outcome = "UNANSWERED"; unanswered += 1; }
    else if (isCorrect(sel, q.correctOptionIds)) { outcome = "CORRECT"; correct += 1; score += hundredths(q.marks); }
    else { outcome = "WRONG"; wrong += 1; }
    perQuestion[q.examQuestionId] = outcome;
    if (q.topicId && outcome !== "UNANSWERED") {
      const t = (byTopic[q.topicId] ??= { attempted: 0, correct: 0 });
      t.attempted += 1;
      if (outcome === "CORRECT") t.correct += 1;
    }
  }
  return { score: score / 100, totalMarks: total / 100, percentage: total ? Math.round((score / total) * 10000) / 100 : 0, correctCount: correct, wrongCount: wrong, unansweredCount: unanswered, perQuestion, byTopic };
}

// ───────────── Deterministic shuffling (so a recovered attempt shows the same paper) ─────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const seedFrom = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const a = [...items];
  const rand = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ───────────── Timing ─────────────

export interface DeadlineRules {
  startedAt: Date;
  durationMinutes: number;
  closesAt?: Date | null;
}

/** Attempt deadline = start + duration, but never later than the exam window closing time. */
export function attemptDeadline(r: DeadlineRules): Date {
  const natural = new Date(r.startedAt.getTime() + r.durationMinutes * 60_000);
  return r.closesAt && r.closesAt < natural ? r.closesAt : natural;
}

export type SaveWindow = "OPEN" | "GRACE" | "OFFLINE_SYNC_ONLY" | "CLOSED";

/**
 * When may answers arrive? Until the deadline (+grace) everything is accepted. In the offline-sync window
 * after that, only answers that the client says were made in time are accepted. After it, nothing.
 */
export function saveWindow(now: Date, deadline: Date, graceSeconds: number, offlineSyncMinutes: number): SaveWindow {
  const t = now.getTime();
  const d = deadline.getTime();
  if (t <= d) return "OPEN";
  if (t <= d + graceSeconds * 1000) return "GRACE";
  if (t <= d + offlineSyncMinutes * 60_000) return "OFFLINE_SYNC_ONLY";
  return "CLOSED";
}

export function answerAcceptable(window: SaveWindow, answeredAt: Date | null, deadline: Date, graceSeconds: number): boolean {
  if (window === "OPEN" || window === "GRACE") return true;
  if (window === "CLOSED") return false;
  return !!answeredAt && answeredAt.getTime() <= deadline.getTime() + graceSeconds * 1000;
}

// ───────────── Item analysis ─────────────

export interface AttemptSummary {
  attemptId: string;
  percentage: number;
  perQuestion: Record<string, "CORRECT" | "WRONG" | "UNANSWERED">;
}

/**
 * Classical test theory: difficulty index p (share correct) and discrimination D (upper 27% − lower 27%).
 * Flags: p < 0.2 "very hard / possibly mis-keyed", p > 0.9 "very easy", D < 0.1 "does not discriminate".
 */
export function itemAnalysis(questionIds: readonly string[], attempts: readonly AttemptSummary[]) {
  const n = attempts.length;
  const sorted = [...attempts].sort((a, b) => b.percentage - a.percentage);
  const groupSize = Math.max(1, Math.round(n * 0.27));
  const upper = sorted.slice(0, groupSize);
  const lower = sorted.slice(-groupSize);
  return questionIds.map((id) => {
    const correct = attempts.filter((a) => a.perQuestion[id] === "CORRECT").length;
    const p = n ? correct / n : 0;
    const share = (grp: AttemptSummary[]) => (grp.length ? grp.filter((a) => a.perQuestion[id] === "CORRECT").length / grp.length : 0);
    const d = n >= 4 ? share(upper) - share(lower) : null;
    const flags: string[] = [];
    if (n >= 5) {
      if (p < 0.2) flags.push("VERY_HARD");
      if (p > 0.9) flags.push("VERY_EASY");
      if (d !== null && d < 0.1) flags.push("LOW_DISCRIMINATION");
    }
    return { examQuestionId: id, attempts: n, correct, difficulty: Math.round(p * 1000) / 1000, discrimination: d === null ? null : Math.round(d * 1000) / 1000, flags };
  });
}

export function histogram(percentages: readonly number[], bucket = 10) {
  const buckets = Array.from({ length: Math.ceil(100 / bucket) }, (_, i) => ({ from: i * bucket, to: Math.min(100, (i + 1) * bucket), count: 0 }));
  for (const p of percentages) buckets[Math.min(buckets.length - 1, Math.floor(p / bucket))]!.count += 1;
  return buckets;
}

/** Weak-topic ranking: lowest accuracy first, ignoring topics with too little evidence. */
export function weakTopics(rows: readonly { topicId: string; attempted: number; correct: number }[], minAttempts = 5) {
  return rows
    .filter((r) => r.attempted >= minAttempts)
    .map((r) => ({ ...r, accuracy: Math.round((r.correct / r.attempted) * 1000) / 10 }))
    .sort((a, b) => a.accuracy - b.accuracy || b.attempted - a.attempted);
}

// ───────────── Exam-prep presets (data, not four separate engines) ─────────────

export interface ExamPreset {
  body: "WAEC" | "NECO" | "JAMB" | "BECE";
  label: string;
  /** Subjects sat in a full mock (compulsory ones are listed by name; the rest are chosen by the student). */
  compulsorySubjectNames: string[];
  subjectsPerMock: number;
  questionsPerSubject: number;
  minutesPerMock: number;
}

export const EXAM_PRESETS: Record<ExamPreset["body"], ExamPreset> = {
  JAMB: { body: "JAMB", label: "JAMB UTME", compulsorySubjectNames: ["English Language"], subjectsPerMock: 4, questionsPerSubject: 40, minutesPerMock: 120 },
  WAEC: { body: "WAEC", label: "WAEC SSCE (objective)", compulsorySubjectNames: ["English Language", "Mathematics"], subjectsPerMock: 1, questionsPerSubject: 50, minutesPerMock: 60 },
  NECO: { body: "NECO", label: "NECO SSCE (objective)", compulsorySubjectNames: ["English Language", "Mathematics"], subjectsPerMock: 1, questionsPerSubject: 50, minutesPerMock: 60 },
  BECE: { body: "BECE", label: "BECE (JSS3)", compulsorySubjectNames: ["English Studies", "Mathematics"], subjectsPerMock: 1, questionsPerSubject: 60, minutesPerMock: 90 },
};

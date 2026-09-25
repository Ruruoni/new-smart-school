/**
 * Timetable constraint model + deterministic solver. Pure: no database, so the exact same conflict
 * rules validate manual edits and drive automatic generation (and are unit-tested in isolation).
 */
export interface Lesson {
  id: string; // classSubject id
  classId: string;
  /** Section id, or "*" for a whole-class lesson. */
  sectionKey: string;
  subjectId: string;
  teacherId: string;
  periodsPerWeek: number;
  roomId?: string | null;
  resourceId?: string | null;
}

export interface Placement {
  lessonId: string;
  dayOfWeek: number;
  periodIndex: number;
}

export interface Occupied {
  dayOfWeek: number;
  periodIndex: number;
  classId: string;
  sectionKey: string;
  teacherId: string;
  roomId?: string | null;
  resourceId?: string | null;
}

export type ConflictKind = "TEACHER" | "ROOM" | "RESOURCE" | "CLASS";
export interface Conflict {
  kind: ConflictKind;
  message: string;
}

/** Whole-class ("*") and section lessons of the same class collide; two different sections do not. */
export const sectionsOverlap = (a: string, b: string) => a === "*" || b === "*" || a === b;

export function findConflicts(candidate: Occupied, existing: readonly Occupied[]): Conflict[] {
  const out: Conflict[] = [];
  for (const o of existing) {
    if (o.dayOfWeek !== candidate.dayOfWeek || o.periodIndex !== candidate.periodIndex) continue;
    if (o.teacherId === candidate.teacherId) out.push({ kind: "TEACHER", message: "Teacher is already teaching another class in this period" });
    if (candidate.roomId && o.roomId === candidate.roomId) out.push({ kind: "ROOM", message: "Room is already booked in this period" });
    if (candidate.resourceId && o.resourceId === candidate.resourceId) out.push({ kind: "RESOURCE", message: "Shared resource is already booked in this period" });
    if (o.classId === candidate.classId && sectionsOverlap(o.sectionKey, candidate.sectionKey)) out.push({ kind: "CLASS", message: "This class already has a lesson in this period" });
  }
  return out;
}

export interface SolveInput {
  days: number[]; // e.g. [1,2,3,4,5]
  periodsPerDay: number;
  lessons: Lesson[];
  /** Already-fixed slots (existing timetable content, or unavailable teacher periods modelled as Occupied). */
  fixed?: Occupied[];
  seed?: number;
  attempts?: number;
  /** Max lessons of one subject per class per day (default 2 so subjects spread across the week). */
  maxPerSubjectPerDay?: number;
}

export interface SolveResult {
  placements: Placement[];
  unplaced: { lessonId: string; missing: number; reason: string }[];
}

// Small deterministic PRNG so "generate" is reproducible for the same input.
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

function attempt(input: SolveInput, rand: () => number): SolveResult {
  const { days, periodsPerDay, lessons } = input;
  const maxPerDay = input.maxPerSubjectPerDay ?? 2;
  const occupied: Occupied[] = [...(input.fixed ?? [])];
  const placements: Placement[] = [];
  const perDay = new Map<string, number>(); // classId|subject|day → count
  const teacherLoad = new Map<string, number>();
  for (const l of lessons) teacherLoad.set(l.teacherId, (teacherLoad.get(l.teacherId) ?? 0) + l.periodsPerWeek);

  // Most constrained first: busy teachers and shared resources, then bigger demands; jitter breaks ties per attempt.
  const order = [...lessons].sort((a, b) => (teacherLoad.get(b.teacherId)! - teacherLoad.get(a.teacherId)!) || (b.periodsPerWeek - a.periodsPerWeek) || (rand() < 0.5 ? -1 : 1));
  const unplaced: SolveResult["unplaced"] = [];

  for (const l of order) {
    let placed = 0;
    let lastReason = "No free period satisfies every constraint";
    for (let unit = 0; unit < l.periodsPerWeek; unit++) {
      // Candidate slots, preferring days where this subject is least used (spreads the week), then random.
      const cands: { d: number; p: number; score: number }[] = [];
      for (const d of days) for (let p = 0; p < periodsPerDay; p++) cands.push({ d, p, score: (perDay.get(`${l.classId}|${l.subjectId}|${d}`) ?? 0) * 10 + rand() });
      cands.sort((a, b) => a.score - b.score);
      let done = false;
      for (const c of cands) {
        if ((perDay.get(`${l.classId}|${l.subjectId}|${c.d}`) ?? 0) >= maxPerDay) { lastReason = "Would exceed the daily limit for this subject"; continue; }
        const occ: Occupied = { dayOfWeek: c.d, periodIndex: c.p, classId: l.classId, sectionKey: l.sectionKey, teacherId: l.teacherId, roomId: l.roomId, resourceId: l.resourceId };
        const conflicts = findConflicts(occ, occupied);
        if (conflicts.length) { lastReason = conflicts[0]!.message; continue; }
        occupied.push(occ);
        placements.push({ lessonId: l.id, dayOfWeek: c.d, periodIndex: c.p });
        perDay.set(`${l.classId}|${l.subjectId}|${c.d}`, (perDay.get(`${l.classId}|${l.subjectId}|${c.d}`) ?? 0) + 1);
        placed += 1;
        done = true;
        break;
      }
      if (!done) break;
    }
    if (placed < l.periodsPerWeek) unplaced.push({ lessonId: l.id, missing: l.periodsPerWeek - placed, reason: lastReason });
  }
  return { placements, unplaced };
}

/** Multi-start greedy: several seeded attempts, keep the one that places the most periods. Deterministic per seed. */
export function solveTimetable(input: SolveInput): SolveResult {
  const attempts = input.attempts ?? 40;
  let best: SolveResult | null = null;
  const rand = mulberry32(input.seed ?? 1);
  for (let i = 0; i < attempts; i++) {
    const r = attempt(input, rand);
    if (!best || r.placements.length > best.placements.length) best = r;
    if (!r.unplaced.length) return r;
  }
  return best!;
}

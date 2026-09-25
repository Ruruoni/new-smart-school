import { describe, expect, it } from "vitest";
import { answerAcceptable, attemptDeadline, histogram, isCorrect, itemAnalysis, saveWindow, scoreAttempt, seedFrom, shuffled, weakTopics } from "@/modules/cbt/scoring";

const Q = (id: string, correct: string[], marks = 1, topicId: string | null = "t1") => ({ examQuestionId: id, marks, topicId, correctOptionIds: correct });

describe("scoring", () => {
  it("single, multi and unanswered", () => {
    const qs = [Q("q1", ["a"]), Q("q2", ["b", "c"], 2), Q("q3", ["d"]), Q("q4", ["a"], 1, "t2")];
    const r = scoreAttempt(qs, [{ examQuestionId: "q1", selectedOptionIds: ["a"] }, { examQuestionId: "q2", selectedOptionIds: ["c", "b"] }, { examQuestionId: "q3", selectedOptionIds: ["x"] }]);
    expect(r).toMatchObject({ score: 3, totalMarks: 5, percentage: 60, correctCount: 2, wrongCount: 1, unansweredCount: 1 });
    expect(r.byTopic).toEqual({ t1: { attempted: 3, correct: 2 } }); // unanswered does not count as attempted
  });
  it("partial multi-select is wrong; duplicate selections are wrong", () => {
    expect(isCorrect(["b"], ["b", "c"])).toBe(false);
    expect(isCorrect(["b", "c", "d"], ["b", "c"])).toBe(false);
    expect(isCorrect(["b", "b"], ["b", "b"])).toBe(false);
    expect(isCorrect([], [])).toBe(false);
  });
  it("decimal marks stay exact", () => {
    const r = scoreAttempt([Q("a", ["1"], 0.1), Q("b", ["1"], 0.2)], [{ examQuestionId: "a", selectedOptionIds: ["1"] }, { examQuestionId: "b", selectedOptionIds: ["1"] }]);
    expect(r.score).toBe(0.3);
    expect(r.percentage).toBe(100);
  });
  it("empty exam does not divide by zero", () => expect(scoreAttempt([], []).percentage).toBe(0));
});

describe("shuffling", () => {
  it("is deterministic for a seed and a true permutation", () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const a = shuffled(items, seedFrom("attempt-1"));
    expect(shuffled(items, seedFrom("attempt-1"))).toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(shuffled(items, seedFrom("attempt-2"))).not.toEqual(a);
  });
});

describe("timing rules", () => {
  const start = new Date("2026-03-01T09:00:00Z");
  it("deadline = start + duration, capped by the exam window", () => {
    expect(attemptDeadline({ startedAt: start, durationMinutes: 60 }).toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(attemptDeadline({ startedAt: start, durationMinutes: 60, closesAt: new Date("2026-03-01T09:30:00Z") }).toISOString()).toBe("2026-03-01T09:30:00.000Z");
    expect(attemptDeadline({ startedAt: start, durationMinutes: 60, closesAt: new Date("2026-03-01T12:00:00Z") }).toISOString()).toBe("2026-03-01T10:00:00.000Z");
  });
  const deadline = new Date("2026-03-01T10:00:00Z");
  const at = (sec: number) => new Date(deadline.getTime() + sec * 1000);
  it("windows", () => {
    expect(saveWindow(at(-5), deadline, 15, 10)).toBe("OPEN");
    expect(saveWindow(at(10), deadline, 15, 10)).toBe("GRACE");
    expect(saveWindow(at(120), deadline, 15, 10)).toBe("OFFLINE_SYNC_ONLY");
    expect(saveWindow(at(601), deadline, 15, 10)).toBe("CLOSED");
  });
  it("offline sync accepts only in-time answers", () => {
    expect(answerAcceptable("OFFLINE_SYNC_ONLY", at(-30), deadline, 15)).toBe(true);
    expect(answerAcceptable("OFFLINE_SYNC_ONLY", at(60), deadline, 15)).toBe(false);
    expect(answerAcceptable("OFFLINE_SYNC_ONLY", null, deadline, 15)).toBe(false);
    expect(answerAcceptable("CLOSED", at(-30), deadline, 15)).toBe(false);
    expect(answerAcceptable("OPEN", null, deadline, 15)).toBe(true);
  });
});

describe("item analysis & analytics", () => {
  const mk = (id: string, pct: number, q1: "CORRECT" | "WRONG", q2: "CORRECT" | "WRONG") => ({ attemptId: id, percentage: pct, perQuestion: { q1, q2 } });
  it("computes difficulty and discrimination and flags weak items", () => {
    const attempts = [mk("a", 90, "CORRECT", "WRONG"), mk("b", 80, "CORRECT", "WRONG"), mk("c", 70, "CORRECT", "WRONG"), mk("d", 40, "WRONG", "WRONG"), mk("e", 30, "WRONG", "CORRECT"), mk("f", 20, "WRONG", "WRONG")];
    const [q1, q2] = itemAnalysis(["q1", "q2"], attempts);
    expect(q1).toMatchObject({ correct: 3, difficulty: 0.5 });
    expect(q1!.discrimination).toBeGreaterThan(0.5);
    expect(q2!.flags).toContain("LOW_DISCRIMINATION");
    expect(itemAnalysis(["q1"], attempts.slice(0, 2))[0]!.flags).toEqual([]); // too few attempts to judge
  });
  it("histogram buckets", () => {
    const h = histogram([0, 9.9, 10, 55, 100, 100]);
    expect(h[0]!.count).toBe(2);
    expect(h[1]!.count).toBe(1);
    expect(h[9]!.count).toBe(2); // 100 lands in the last bucket
  });
  it("weak topics: needs evidence, lowest accuracy first", () => {
    const w = weakTopics([{ topicId: "a", attempted: 10, correct: 9 }, { topicId: "b", attempted: 10, correct: 3 }, { topicId: "c", attempted: 2, correct: 0 }]);
    expect(w.map((x) => x.topicId)).toEqual(["b", "a"]);
    expect(w[0]!.accuracy).toBe(30);
  });
});

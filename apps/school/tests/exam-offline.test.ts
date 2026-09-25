import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { clockOffset, formatClock, mergeAnswers, progress, questionState, remainingSeconds, syncDelayMs, timeWarning, toggleOption, type LocalAnswer } from "@/lib/exam-logic";
import * as store from "@/lib/exam-store";

const ans = (id: string, sel: string[], seq: number, o: Partial<LocalAnswer> = {}): LocalAnswer => ({ examQuestionId: id, selectedOptionIds: sel, flagged: false, visited: true, clientSeq: seq, answeredAt: null, dirty: true, ...o });

describe("merge after refresh (server copy vs this device)", () => {
  it("keeps offline answers the server never saw, and prefers the higher sequence", () => {
    const server = { q1: { selectedOptionIds: ["a"], flagged: false, visited: true, clientSeq: 3 }, q2: { selectedOptionIds: ["b"], flagged: false, visited: true, clientSeq: 1 } };
    const m = mergeAnswers(server, [ans("q1", ["c"], 5), ans("q2", ["x"], 1, { dirty: false }), ans("q3", ["z"], 2)]);
    expect(m.q1!.selectedOptionIds).toEqual(["c"]); // offline edit newer than server
    expect(m.q2!.selectedOptionIds).toEqual(["b"]); // equal seq, clean local copy → server wins
    expect(m.q3!.selectedOptionIds).toEqual(["z"]); // never reached the server
    expect(mergeAnswers({ q1: { ...server.q1, clientSeq: 9 } }, [ans("q1", ["old"], 4)]).q1!.selectedOptionIds).toEqual(["a"]); // stale local loses
  });
});

describe("timing", () => {
  it("uses the server clock, so a wrong device clock cannot extend or shorten the exam", () => {
    const serverNow = Date.parse("2026-03-01T09:00:00Z"), deviceNow = Date.parse("2026-03-01T09:30:00Z"); // device clock 30 min fast
    const off = clockOffset(serverNow, deviceNow);
    const deadline = Date.parse("2026-03-01T09:45:00Z");
    expect(remainingSeconds(deadline, deviceNow, off)).toBe(45 * 60);
    expect(remainingSeconds(deadline, deviceNow + 44 * 60_000, off)).toBe(60);
    expect(remainingSeconds(deadline, deviceNow + 60 * 60_000, off)).toBe(0); // never negative
  });
  it("formats and warns", () => {
    expect(formatClock(3725)).toBe("1:02:05"); expect(formatClock(65)).toBe("01:05"); expect(formatClock(0)).toBe("00:00");
    expect(timeWarning(0, 3600)).toBe("expired"); expect(timeWarning(50, 3600)).toBe("1min"); expect(timeWarning(280, 3600)).toBe("5min"); expect(timeWarning(590, 3600)).toBe("10min"); expect(timeWarning(1000, 3600)).toBeNull();
    expect(timeWarning(200, 400)).toBeNull(); // short exams: no 5/10-minute nags
  });
  it("autosave back-off caps at 15s", () => expect([1, 2, 3, 4, 5, 9].map(syncDelayMs)).toEqual([2000, 4000, 8000, 15000, 15000, 15000]));
});

describe("question map & options", () => {
  it("colours: flagged > answered > visited > unvisited", () => {
    expect(questionState(undefined)).toBe("unvisited");
    expect(questionState({ selectedOptionIds: [], flagged: false, visited: false })).toBe("unvisited");
    expect(questionState({ selectedOptionIds: [], flagged: false, visited: true })).toBe("visited");
    expect(questionState({ selectedOptionIds: ["a"], flagged: false, visited: true })).toBe("answered");
    expect(questionState({ selectedOptionIds: [], flagged: true, visited: true })).toBe("flagged");
    expect(questionState({ selectedOptionIds: ["a"], flagged: true, visited: true })).toBe("answeredFlagged");
    expect(progress(["answered", "flagged", "unvisited", "visited", "answeredFlagged"])).toEqual({ total: 5, answered: 2, flagged: 2, unanswered: 3, remaining: 3 });
  });
  it("single choice replaces/clears, multiple toggles", () => {
    expect(toggleOption([], "a", false)).toEqual(["a"]); expect(toggleOption(["a"], "b", false)).toEqual(["b"]); expect(toggleOption(["a"], "a", false)).toEqual([]);
    expect(toggleOption(["a"], "b", true)).toEqual(["a", "b"]); expect(toggleOption(["a", "b"], "a", true)).toEqual(["b"]);
  });
});

describe("IndexedDB store (survives 'refresh')", () => {
  beforeEach(async () => { store.__resetForTests(); await store.clearAttempt("att-1"); await store.clearAttempt("att-2"); });
  it("persists the paper and answers per attempt", async () => {
    await store.savePaper("att-1", { questions: [1, 2, 3] });
    await store.putAnswer("att-1", ans("q1", ["a"], 1)); await store.putAnswer("att-1", ans("q2", ["b"], 1)); await store.putAnswer("att-2", ans("q1", ["z"], 1));
    store.__resetForTests(); // simulate a browser restart: a fresh connection to the same database
    expect(await store.loadPaper("att-1")).toEqual({ questions: [1, 2, 3] });
    expect((await store.loadAnswers("att-1")).map((a) => a.examQuestionId).sort()).toEqual(["q1", "q2"]);
    expect(await store.loadAnswers("att-2")).toHaveLength(1);
    expect(await store.loadPaper("nope")).toBeNull();
  });
  it("marks synced only what was sent; an edit made mid-flight stays dirty", async () => {
    await store.putAnswer("att-1", ans("q1", ["a"], 1)); await store.putAnswer("att-1", ans("q2", ["b"], 4));
    await store.putAnswer("att-1", ans("q1", ["a2"], 2)); // student changed q1 while the request for seq 1 was in flight
    await store.markSynced("att-1", { q1: 1, q2: 4 });
    const dirty = await store.dirtyAnswers("att-1");
    expect(dirty.map((d) => [d.examQuestionId, d.selectedOptionIds])).toEqual([["q1", ["a2"]]]);
  });
  it("clears everything for a finished attempt and stores meta", async () => {
    await store.savePaper("att-1", {}); await store.putAnswer("att-1", ans("q1", [], 1));
    await store.clearAttempt("att-1");
    expect(await store.loadAnswers("att-1")).toEqual([]); expect(await store.loadPaper("att-1")).toBeNull();
    await store.setMeta("k", { a: 1 }); expect(await store.getMeta("k")).toEqual({ a: 1 });
  });
});

import { describe, expect, it } from "vitest";
import { average, computeSubject, decidePromotion, gradeFor, ordinal, rank, round2, validateBands, validateComponents, type Component, type GradeBand } from "@/modules/results/engine";

const bands: GradeBand[] = [
  ["A1", 75, 100], ["B2", 70, 74.99], ["B3", 65, 69.99], ["C4", 60, 64.99], ["C5", 55, 59.99], ["C6", 50, 54.99], ["D7", 45, 49.99], ["E8", 40, 44.99], ["F9", 0, 39.99],
].map(([grade, minScore, maxScore]) => ({ grade: grade as string, minScore: minScore as number, maxScore: maxScore as number, isPass: grade !== "F9" }));
const comps: Component[] = [
  { id: "ca1", code: "CA1", maxScore: 20, isExam: false },
  { id: "ca2", code: "CA2", maxScore: 20, isExam: false },
  { id: "ex", code: "EXAM", maxScore: 60, isExam: true },
];

describe("grading", () => {
  it.each([[100, "A1"], [75, "A1"], [74.99, "B2"], [74.5, "B2"], [70, "B2"], [69.999, "B2"], [40, "E8"], [39.99, "F9"], [0, "F9"]])("%d → %s", (p, g) => expect(gradeFor(p, bands)?.grade).toBe(g));
  it("validates band sets", () => {
    expect(validateBands(bands)).toEqual([]);
    expect(validateBands([{ grade: "A", minScore: 50, maxScore: 100, isPass: true }])).toContain("Bands must start at 0");
    expect(validateBands([{ grade: "A", minScore: 0, maxScore: 60, isPass: true }, { grade: "B", minScore: 55, maxScore: 100, isPass: true }]).join()).toMatch(/overlaps/);
  });
  it("validates components sum to 100 with exactly one exam", () => {
    expect(validateComponents(comps)).toEqual([]);
    expect(validateComponents([{ ...comps[0]!, maxScore: 30 }, comps[1]!, comps[2]!]).join()).toMatch(/add up to 100/);
    expect(validateComponents(comps.map((x) => ({ ...x, isExam: false }))).join()).toMatch(/one component/);
  });
});

describe("subject computation", () => {
  const sc = (o: Record<string, number | null | "abs">) => new Map(Object.entries(o).map(([k, v]) => [k, v === "abs" ? { score: null, isAbsent: true } : { score: v, isAbsent: false }]));
  it("sums CA and exam with exact decimal handling", () => {
    const r = computeSubject(comps, sc({ ca1: 12.35, ca2: 17.1, ex: 40.55 }));
    expect(r).toMatchObject({ caTotal: 29.45, examScore: 40.55, total: 70, percentage: 70 });
    expect(gradeFor(r.percentage, bands)?.grade).toBe("B2");
  });
  it("reports missing components and counts them as zero", () => {
    const r = computeSubject(comps, sc({ ca1: 10, ex: 30 }));
    expect(r.missing).toEqual(["CA2"]);
    expect(r.total).toBe(40);
  });
  it("absent scores are zero but not 'missing'", () => {
    const r = computeSubject(comps, sc({ ca1: 10, ca2: 10, ex: "abs" }));
    expect(r.missing).toEqual([]);
    expect(r.total).toBe(20);
  });
  it("clamps a score above its component maximum", () => {
    expect(computeSubject(comps, sc({ ca1: 25, ca2: 0, ex: 0 })).caTotal).toBe(20);
  });
  it("works with non-100 component totals via percentage", () => {
    const r = computeSubject([{ id: "a", code: "A", maxScore: 40, isExam: false }, { id: "b", code: "B", maxScore: 60, isExam: true }], sc({ a: 20, b: 45 }));
    expect(r.percentage).toBe(65);
  });
});

describe("ranking", () => {
  const items = [{ id: "a", value: 90 }, { id: "b", value: 80 }, { id: "c", value: 80 }, { id: "d", value: 70 }];
  it("standard competition: 1,2,2,4", () => expect([...rank(items).entries()]).toEqual([["a", 1], ["b", 2], ["c", 2], ["d", 4]]));
  it("dense: 1,2,2,3", () => expect(rank(items, "DENSE").get("d")).toBe(3));
  it("compares in hundredths", () => expect(rank([{ id: "x", value: 70.1 }, { id: "y", value: 70.10 }]).get("y")).toBe(1));
  it("empty input", () => expect(rank([]).size).toBe(0));
  it("ordinals", () => expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]));
});

describe("averages and promotion", () => {
  it("averages to 2dp", () => expect(average([70, 65.5, 80])).toBe(71.83));
  it("round2 half-up", () => expect(round2(1.005)).toBe(1.01));
  it("promotion decisions", () => {
    expect(decidePromotion({ average: 55, minimumAverage: 40, isTerminalClass: false }).decision).toBe("PROMOTED");
    expect(decidePromotion({ average: 35, minimumAverage: 40, isTerminalClass: false }).decision).toBe("REPEATED");
    expect(decidePromotion({ average: 80, minimumAverage: 40, isTerminalClass: true }).decision).toBe("GRADUATED");
    expect(decidePromotion({ average: 80, minimumAverage: 40, isTerminalClass: false, failedCoreSubjects: 3, maxFailedCore: 2 }).decision).toBe("REPEATED");
  });
});

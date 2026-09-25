import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { request } from "@playwright/test";
import { ADMIN, BASE_URL } from "./env";
import { adminApi, get, post, put } from "./helpers";

export interface State {
  yearId: string; termId: string; term2Id: string; jss1: string; jss2: string; ss1: string; secA: string; math: string; eng: string;
  teacher: { id: string; userId: string; username: string; password: string };
  classSubjectId: string;
}
const FILE = "e2e/.state.json";
export const loadState = (): State => JSON.parse(readFileSync(FILE, "utf8"));

/** Give a freshly created user a known password (they'd normally do this at first sign-in). */
export async function activateUser(username: string, temp: string, password: string) {
  const ctx = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin: BASE_URL } });
  const r = await ctx.post("/api/auth/login", { data: { username, password: temp } });
  if (!r.ok()) throw new Error(`activate login failed: ${await r.text()}`);
  const c = await ctx.post("/api/auth/change-password", { data: { currentPassword: temp, newPassword: password } });
  if (!c.ok()) throw new Error(`activate change failed: ${await c.text()}`);
  await ctx.dispose();
}

/** Run the real setup endpoint if this database is still empty (specs can then run alone or together). */
export async function ensureInstalled() {
  const ctx = await request.newContext({ baseURL: BASE_URL });
  const st = await (await ctx.get("/api/setup/status")).json();
  if (st.data.needsSetup) {
    const r = await ctx.post("/api/setup", { data: { schoolName: "Greenfield College", city: "Enugu", admin: { username: ADMIN.username, password: ADMIN.password, firstName: "Ada", lastName: "Obi" } } });
    if (!r.ok()) throw new Error(`setup failed: ${await r.text()}`);
  }
  await ctx.dispose();
}

/** Academic structure, one teacher with a class-subject, and fee structure. Idempotent. */
export async function seedSchool(): Promise<State> {
  await ensureInstalled();
  if (existsSync(FILE)) return loadState();
  const api = await adminApi();
  const year = await post(api, "/academics/years", { name: "2025/2026", startDate: "2025-09-01", endDate: "2035-07-31" });
  const t1 = await post(api, "/academics/terms", { academicYearId: year.id, name: "First Term", sequence: 1, startDate: "2025-09-01", endDate: "2026-12-15" });
  const t2 = await post(api, "/academics/terms", { academicYearId: year.id, name: "Second Term", sequence: 2, startDate: "2027-01-05", endDate: "2027-04-10" });
  await post(api, `/academics/terms/${t1.id}/current`);
  const ss1 = await post(api, "/academics/classes", { name: "SS 1", level: 4, stage: "SENIOR_SECONDARY" });
  const jss2 = await post(api, "/academics/classes", { name: "JSS 2", level: 2, stage: "JUNIOR_SECONDARY", nextClassId: ss1.id });
  const jss1 = await post(api, "/academics/classes", { name: "JSS 1", level: 1, stage: "JUNIOR_SECONDARY", nextClassId: jss2.id });
  const secA = await post(api, "/academics/sections", { classId: jss1.id, name: "A", capacity: 40 });
  const math = await post(api, "/academics/subjects", { code: "MTH", name: "Mathematics", isCompulsory: true });
  const eng = await post(api, "/academics/subjects", { code: "ENG", name: "English Language", isCompulsory: true });
  const tr = await post(api, "/teachers", { firstName: "Emeka", lastName: "Nwosu", qualification: "B.Ed Mathematics" });
  await activateUser(tr.username, tr.initialPassword, "Teacher-pass-1");
  const cs = await post(api, "/academics/class-subjects", { classId: jss1.id, subjectId: math.id, teacherId: tr.teacher.id });
  await post(api, "/finance/fee-structures", { name: "JSS 1 — First term", termId: t1.id, classId: jss1.id, items: [{ name: "Tuition", amount: 70000 }, { name: "PTA levy", amount: 5000 }] });
  const state: State = { yearId: year.id, termId: t1.id, term2Id: t2.id, jss1: jss1.id, jss2: jss2.id, ss1: ss1.id, secA: secA.id, math: math.id, eng: eng.id, teacher: { id: tr.teacher.id, userId: tr.teacher.userId, username: tr.username, password: "Teacher-pass-1" }, classSubjectId: cs.id };
  writeFileSync(FILE, JSON.stringify(state, null, 2));
  await api.dispose();
  void get; void put;
  return state;
}

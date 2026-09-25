import { db } from "@/platform/db";
import { authorize } from "@/platform/security/interceptor";
import * as academics from "@/modules/academics/service";
import { ADMIN, installTestSchool, req, sessionFor } from "./helpers";
import type { SecurityContext } from "@/platform/security/context";

export async function adminCtx(): Promise<SecurityContext> {
  return ctxFor("owner", ADMIN.password);
}
export async function ctxFor(username: string, password?: string): Promise<SecurityContext> {
  return authorize({}, req("/x", { cookie: await sessionFor(username, password) }));
}

/** Installed school + current year/term + JSS1–SS1 promotion path + a few subjects. */
export async function seedAcademics() {
  await installTestSchool();
  const admin = await adminCtx();
  const year = await academics.createAcademicYear(admin, { name: "2025/2026", startDate: "2025-09-01", endDate: "2026-07-31" });
  const t1 = await academics.createTerm(admin, { academicYearId: year.id, name: "First Term", sequence: 1, startDate: "2025-09-01", endDate: "2025-12-15" });
  const t2 = await academics.createTerm(admin, { academicYearId: year.id, name: "Second Term", sequence: 2, startDate: "2026-01-05", endDate: "2026-04-10" });
  await academics.setCurrentTerm(admin, t1.id);
  const ss1 = await academics.createClass(admin, { name: "SS 1", level: 4, stage: "SENIOR_SECONDARY" });
  const jss2 = await academics.createClass(admin, { name: "JSS 2", level: 2, stage: "JUNIOR_SECONDARY", nextClassId: null });
  const jss1 = await academics.createClass(admin, { name: "JSS 1", level: 1, stage: "JUNIOR_SECONDARY", nextClassId: jss2.id });
  await academics.updateClass(admin, jss2.id, { version: jss2.version, nextClassId: ss1.id });
  const secA = await academics.createSection(admin, { classId: jss1.id, name: "A", capacity: 40 });
  const math = await academics.createSubject(admin, { code: "MTH", name: "Mathematics", isCompulsory: true });
  const eng = await academics.createSubject(admin, { code: "ENG", name: "English Language", isCompulsory: true });
  const bio = await academics.createSubject(admin, { code: "BIO", name: "Biology" });
  return { admin, year, t1, t2, jss1, jss2, ss1, secA, math, eng, bio, db };
}

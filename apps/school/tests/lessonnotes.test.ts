import { beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { db } from "@/platform/db";
import * as notes from "@/modules/lessonnotes/service";
import * as academics from "@/modules/academics/service";
import * as people from "@/modules/people/service";
import { openFile } from "@/platform/files";
import { hashPassword } from "@/platform/password";
import { ctxFor, seedAcademics } from "./fixtures";
import { resetDb } from "./helpers";

let S: Awaited<ReturnType<typeof seedAcademics>>;
let t1: Awaited<ReturnType<typeof ctxFor>>, t2: Awaited<ReturnType<typeof ctxFor>>;
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 2)]);
const body = { topic: "Quadratic equations", title: "Solving by factorisation", body: "Step 1…" };

async function teacher(first: string) {
  const t = await people.createTeacher(S.admin, { firstName: first, lastName: "Teacher" });
  await db.user.update({ where: { id: t.teacher.userId }, data: { passwordHash: await hashPassword("Teach-pass-1"), mustChangePassword: false } });
  return { t, ctx: await ctxFor(t.username, "Teach-pass-1") };
}
async function family() {
  const r = await people.createStudent(S.admin, { firstName: "Stu", lastName: "Dent", gender: "MALE", classId: S.jss1.id, createLogin: true, guardians: [{ newParent: { firstName: "Par", lastName: "Ent", phone: "08055559999" }, relationship: "Mother" }] });
  const pw = await hashPassword("Fam-pass-123");
  await db.user.updateMany({ where: { id: { in: [r.student.userId!, (await db.parentProfile.findFirstOrThrow()).userId] } }, data: { passwordHash: pw, mustChangePassword: false } });
  const parentUser = await db.user.findFirstOrThrow({ where: { userType: "PARENT" } });
  return { student: await ctxFor(r.username!, "Fam-pass-123"), parent: await ctxFor(parentUser.username, "Fam-pass-123") };
}

beforeEach(async () => {
  await rm("./.data/test-storage", { recursive: true, force: true });
  await resetDb();
  S = await seedAcademics();
  const a = await teacher("Alpha"), b = await teacher("Beta");
  t1 = a.ctx; t2 = b.ctx;
  await academics.assignClassSubject(S.admin, { classId: S.jss1.id, subjectId: S.math.id, teacherId: a.t.teacher.id });
});

describe("lesson notes", () => {
  it("teachers write notes only for class-subjects they are assigned to", async () => {
    const n = await notes.createNote(t1, { ...body, classId: S.jss1.id, subjectId: S.math.id });
    expect(n).toMatchObject({ status: "DRAFT", currentVersion: 1 });
    await expect(notes.createNote(t1, { ...body, classId: S.jss1.id, subjectId: S.eng.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(notes.createNote(t2, { ...body, classId: S.jss1.id, subjectId: S.math.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.lessonNoteVersion.count()).toBe(1);
  });
  it("other teachers cannot see or edit someone else's note; manage_any can", async () => {
    const n = await notes.createNote(t1, { ...body, classId: S.jss1.id, subjectId: S.math.id });
    await expect(notes.getNote(t2, n.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(notes.updateNote(t2, n.id, { version: n.version, title: "Hijack" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await notes.listNotes(t2, {})).total).toBe(0);
    expect((await notes.listNotes(S.admin, {})).total).toBe(1);
  });
  it("versioning: every save snapshots, stale edits are refused, restore creates a new version", async () => {
    const n = await notes.createNote(t1, { ...body, classId: S.jss1.id, subjectId: S.math.id });
    const v2 = await notes.updateNote(t1, n.id, { version: n.version, body: "Revised body" });
    expect(v2.currentVersion).toBe(2);
    await expect(notes.updateNote(t1, n.id, { version: n.version, body: "stale" })).rejects.toMatchObject({ code: "STALE_WRITE" });
    const restored = await notes.restoreVersion(t1, n.id, 1);
    expect(restored).toMatchObject({ body: "Step 1…", currentVersion: 3 });
    expect((await notes.getNote(t1, n.id)).versions.map((v) => v.versionNo)).toEqual([3, 2, 1]);
  });
  it("students and parents see only PUBLISHED notes of their own class; drafts stay private", async () => {
    const { student, parent } = await family();
    const n = await notes.createNote(t1, { ...body, classId: S.jss1.id, subjectId: S.math.id });
    expect((await notes.listNotes(student, {})).total).toBe(0);
    await expect(notes.getNote(student, n.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await notes.setPublished(t1, n.id, true);
    expect((await notes.listNotes(student, {})).total).toBe(1);
    expect((await notes.listNotes(parent, {})).items[0]).not.toHaveProperty("body");
    expect((await notes.getNote(parent, n.id)).versions).toEqual([]); // history is for staff
    const other = await notes.createNote(S.admin.user.isPrimaryAdmin ? t1 : t1, { ...body, title: "Another note", classId: S.jss1.id, subjectId: S.math.id });
    expect(other.id).not.toBe(n.id);
    await notes.setPublished(t1, n.id, false);
    expect((await notes.listNotes(student, {})).total).toBe(0);
    await expect(notes.setPublished(t1, n.id, false)).rejects.toThrow(/Already a draft/);
  });
  it("attachments are type-checked, and only reachable by the right people", async () => {
    const { student } = await family();
    const n = await notes.createNote(t1, { ...body, classId: S.jss1.id, subjectId: S.math.id });
    await expect(notes.attachFile(t1, n.id, { data: Buffer.from("MZ....exe"), originalName: "evil.pdf", declaredMime: "application/pdf" })).rejects.toMatchObject({ code: "FILE_TYPE_NOT_ALLOWED" });
    const att = await notes.attachFile(t1, n.id, { data: PDF, originalName: "../worksheet.pdf", declaredMime: "application/pdf" });
    expect(att.name).toBe("worksheet.pdf");
    await expect(openFile(student, att.fileId)).rejects.toMatchObject({ code: "NOT_FOUND" }); // draft
    await expect(openFile(t2, att.fileId)).rejects.toMatchObject({ code: "NOT_FOUND" }); // other teacher
    expect(await openFile(t1, att.fileId)).toBeInstanceOf(Response);
    await notes.setPublished(t1, n.id, true);
    const res = await openFile(student, att.fileId);
    expect(res.headers.get("content-disposition")).toContain("worksheet.pdf");
    await res.body?.cancel();
    await notes.removeAttachment(t1, n.id, att.id);
    await expect(openFile(student, att.fileId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

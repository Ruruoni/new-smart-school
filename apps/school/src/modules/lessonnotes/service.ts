import { z } from "zod";
import { db, transact, type Tx } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { auditIn } from "@/platform/security/interceptor";
import { teacherProfileId } from "@/platform/security/scope";
import { registerFileReader, saveUpload, deleteFile, type UploadInput } from "@/platform/files";
import { conflict, forbidden, notFound, validation } from "@/platform/errors";
import { assertUpdated, asPage, ilike, skipTake, uuid } from "@/platform/util";

/**
 * Lesson notes: owned by a teacher, scoped to (class, subject). A teacher may only write notes for class-subjects
 * they are assigned to (unless they hold lessonnotes.manage_any). Every save snapshots a version, so a teacher can
 * roll back and the school keeps what students were shown.
 */
export const NoteInput = z.object({
  classId: uuid,
  subjectId: uuid,
  topic: z.string().trim().min(2).max(150),
  title: z.string().trim().min(3).max(200),
  /// Plain text / light markdown. Rendered escaped in the UI — no HTML is ever stored or trusted.
  body: z.string().trim().min(1).max(50_000),
});

async function assertMayWrite(ctx: SecurityContext, tx: Tx | typeof db, classId: string, subjectId: string): Promise<string> {
  const tp = await teacherProfileId(ctx);
  if (!tp && !ctx.can("lessonnotes.manage_any")) throw forbidden("Only teachers can write lesson notes");
  if (!ctx.can("lessonnotes.manage_any")) {
    const assigned = await tx.classSubject.count({ where: { classId, subjectId, teacherId: tp! } });
    if (!assigned) throw forbidden("You are not assigned to teach this subject to this class");
  }
  if (!tp) throw forbidden("Notes must belong to a teacher profile");
  return tp;
}

export async function createNote(ctx: SecurityContext, raw: z.infer<typeof NoteInput>) {
  const i = NoteInput.parse(raw);
  return transact(async (tx) => {
    const teacherId = await assertMayWrite(ctx, tx, i.classId, i.subjectId);
    const note = await tx.lessonNote.create({ data: { ...i, teacherId, versions: { create: { versionNo: 1, title: i.title, body: i.body } } } });
    await auditIn(tx, ctx, { action: "lessonnote.create", module: "lessonnotes", entityType: "LessonNote", entityId: note.id, after: { title: note.title, classId: i.classId, subjectId: i.subjectId } });
    return note;
  });
}

async function loadOwned(ctx: SecurityContext, tx: Tx, id: string) {
  const n = await tx.lessonNote.findUnique({ where: { id } });
  if (!n) throw notFound("Lesson note");
  if (!ctx.can("lessonnotes.manage_any")) {
    const tp = await teacherProfileId(ctx);
    if (!tp || n.teacherId !== tp) throw notFound("Lesson note"); // other teachers' notes are invisible
  }
  return n;
}

export async function updateNote(ctx: SecurityContext, id: string, raw: Partial<z.infer<typeof NoteInput>> & { version: number }) {
  const { version, ...rest } = raw;
  const patch = NoteInput.partial().parse(rest);
  return transact(async (tx) => {
    const before = await loadOwned(ctx, tx, id);
    if (patch.classId || patch.subjectId) await assertMayWrite(ctx, tx, patch.classId ?? before.classId, patch.subjectId ?? before.subjectId);
    const nextVersion = before.currentVersion + 1;
    const r = await tx.lessonNote.updateMany({ where: { id, version }, data: { ...patch, currentVersion: nextVersion, version: { increment: 1 } } });
    assertUpdated(r.count, "Lesson note", before.version);
    const after = await tx.lessonNote.findUniqueOrThrow({ where: { id } });
    await tx.lessonNoteVersion.create({ data: { noteId: id, versionNo: nextVersion, title: after.title, body: after.body } });
    await auditIn(tx, ctx, { action: "lessonnote.update", module: "lessonnotes", entityType: "LessonNote", entityId: id, metadata: { versionNo: nextVersion } });
    return after;
  });
}

export async function setPublished(ctx: SecurityContext, id: string, published: boolean) {
  return transact(async (tx) => {
    const n = await loadOwned(ctx, tx, id);
    if ((n.status === "PUBLISHED") === published) throw conflict(published ? "Already published" : "Already a draft");
    const u = await tx.lessonNote.update({ where: { id }, data: { status: published ? "PUBLISHED" : "DRAFT", publishedAt: published ? new Date() : null, version: { increment: 1 } } });
    await auditIn(tx, ctx, { action: published ? "lessonnote.publish" : "lessonnote.unpublish", module: "lessonnotes", entityType: "LessonNote", entityId: id });
    return u;
  });
}

/** Restoring an old version creates a NEW version (history is append-only). */
export async function restoreVersion(ctx: SecurityContext, id: string, versionNo: number) {
  return transact(async (tx) => {
    const n = await loadOwned(ctx, tx, id);
    const v = await tx.lessonNoteVersion.findUnique({ where: { noteId_versionNo: { noteId: id, versionNo } } });
    if (!v) throw notFound("Version");
    const next = n.currentVersion + 1;
    const u = await tx.lessonNote.update({ where: { id }, data: { title: v.title, body: v.body, currentVersion: next, version: { increment: 1 } } });
    await tx.lessonNoteVersion.create({ data: { noteId: id, versionNo: next, title: v.title, body: v.body } });
    await auditIn(tx, ctx, { action: "lessonnote.restore", module: "lessonnotes", entityType: "LessonNote", entityId: id, metadata: { from: versionNo, to: next } });
    return u;
  });
}

export async function attachFile(ctx: SecurityContext, noteId: string, file: Omit<UploadInput, "profile" | "ownerType" | "ownerId" | "uploadedById">) {
  return transact(async (tx) => {
    await loadOwned(ctx, tx, noteId);
    if ((await tx.lessonNoteAttachment.count({ where: { noteId } })) >= 10) throw validation("A note can have at most 10 attachments");
    const asset = await saveUpload(tx, { ...file, profile: "ATTACHMENT", ownerType: "LESSON_NOTE", ownerId: noteId, uploadedById: ctx.user.id });
    const att = await tx.lessonNoteAttachment.create({ data: { noteId, fileId: asset.id } });
    await auditIn(tx, ctx, { action: "lessonnote.attach", module: "lessonnotes", entityType: "LessonNote", entityId: noteId, metadata: { file: asset.originalName, size: asset.sizeBytes } });
    return { id: att.id, fileId: asset.id, name: asset.originalName, size: asset.sizeBytes };
  });
}

export async function removeAttachment(ctx: SecurityContext, noteId: string, attachmentId: string) {
  return transact(async (tx) => {
    await loadOwned(ctx, tx, noteId);
    const a = await tx.lessonNoteAttachment.findFirst({ where: { id: attachmentId, noteId } });
    if (!a) throw notFound("Attachment");
    await deleteFile(tx, a.fileId, ctx);
    await tx.lessonNoteAttachment.delete({ where: { id: attachmentId } });
    await auditIn(tx, ctx, { action: "lessonnote.detach", module: "lessonnotes", entityType: "LessonNote", entityId: noteId });
  });
}

export const NoteQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20),
  classId: uuid.optional(), subjectId: uuid.optional(), status: z.enum(["DRAFT", "PUBLISHED"]).optional(), q: z.string().trim().max(80).optional(),
});

/** The classes a student (or a parent's children) belong to right now. */
async function familyClassIds(ctx: SecurityContext): Promise<string[]> {
  const where = ctx.user.userType === "STUDENT" ? { student: { userId: ctx.user.id } } : { student: { guardians: { some: { parent: { userId: ctx.user.id } } } } };
  return (await db.enrollment.findMany({ where: { status: "ACTIVE", ...where }, select: { classId: true } })).map((e) => e.classId);
}

/** Teachers see their own notes (all with manage_any); students/parents see PUBLISHED notes of their classes only. */
export async function listNotes(ctx: SecurityContext, raw: z.input<typeof NoteQuery>) {
  const q = NoteQuery.parse(raw);
  const family = ctx.user.userType === "STUDENT" || ctx.user.userType === "PARENT";
  let scope: object;
  if (family) scope = { status: "PUBLISHED", classId: { in: await familyClassIds(ctx) } };
  else if (ctx.can("lessonnotes.manage_any")) scope = {};
  else scope = { teacherId: (await teacherProfileId(ctx)) ?? "00000000-0000-4000-8000-000000000000" };
  const where = { ...scope, ...(q.classId ? { classId: q.classId } : {}), ...(q.subjectId ? { subjectId: q.subjectId } : {}), ...(q.status && !family ? { status: q.status } : {}), ...(q.q ? { OR: [{ title: ilike(q.q) }, { topic: ilike(q.q) }] } : {}) };
  const [items, total] = await Promise.all([
    db.lessonNote.findMany({ where, include: { subject: { select: { name: true } }, class: { select: { name: true } }, teacher: { select: { user: { select: { firstName: true, lastName: true } } } }, _count: { select: { attachments: true } } }, orderBy: { updatedAt: "desc" }, ...skipTake(q) }),
    db.lessonNote.count({ where }),
  ]);
  return asPage(items.map(({ body: _b, ...n }) => n), total, q);
}

export async function getNote(ctx: SecurityContext, id: string) {
  const n = await db.lessonNote.findUnique({ where: { id }, include: { subject: { select: { name: true } }, class: { select: { name: true } }, teacher: { select: { user: { select: { firstName: true, lastName: true } } } }, attachments: true, versions: { orderBy: { versionNo: "desc" }, select: { versionNo: true, title: true, createdAt: true } } } });
  if (!n) throw notFound("Lesson note");
  const family = ctx.user.userType === "STUDENT" || ctx.user.userType === "PARENT";
  if (family) {
    if (n.status !== "PUBLISHED" || !(await familyClassIds(ctx)).includes(n.classId)) throw notFound("Lesson note");
  } else if (!ctx.can("lessonnotes.manage_any")) {
    const tp = await teacherProfileId(ctx);
    if (n.teacherId !== tp) throw notFound("Lesson note");
  }
  const files = await db.fileAsset.findMany({ where: { id: { in: n.attachments.map((a) => a.fileId) }, deletedAt: null }, select: { id: true, originalName: true, sizeBytes: true, mimeType: true } });
  return { ...n, attachments: n.attachments.map((a) => ({ id: a.id, file: files.find((f) => f.id === a.fileId) })).filter((a) => a.file), versions: family ? [] : n.versions };
}

// File access: the owning teacher, staff who can manage any note, or students/parents of the class once published.
registerFileReader("LESSON_NOTE", async (ctx, asset) => {
  if (!asset.ownerId) return false;
  const n = await db.lessonNote.findUnique({ where: { id: asset.ownerId }, select: { teacherId: true, status: true, classId: true } });
  if (!n) return false;
  if (ctx.can("lessonnotes.manage_any")) return true;
  if (ctx.user.userType === "STUDENT" || ctx.user.userType === "PARENT") return n.status === "PUBLISHED" && (await familyClassIds(ctx)).includes(n.classId);
  return n.teacherId === (await teacherProfileId(ctx));
});

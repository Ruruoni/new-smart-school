import { z } from "zod";
import type { Tx } from "@/platform/db";
import { db } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { hashPassword, assertPasswordPolicy } from "@/platform/password";
import { AppError } from "@/platform/errors";
import { createStudentTx, createTeacherTx, findParentByPhone } from "@/modules/people/service";
import { createQuestionTx, QuestionInput } from "@/modules/cbt/bank";
import type { ColumnDef } from "./parse";

export interface RowError {
  field?: string;
  code: string;
  message: string;
}

export interface RefData {
  classes: Map<string, { id: string; name: string }>; // normalised name → class
  sections: Map<string, string>; // `${classId}|${normalised section}` → id
  subjects: Map<string, string>; // normalised name/code → id
  topics: Map<string, string>; // `${subjectId}|${normalised name}` → id
  today: string;
}

export const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export async function loadRefData(): Promise<RefData> {
  const [classes, sections, subjects, topics] = await Promise.all([db.schoolClass.findMany(), db.section.findMany(), db.subject.findMany(), db.cBTTopic.findMany()]);
  return {
    classes: new Map(classes.map((c) => [normKey(c.name), { id: c.id, name: c.name }])),
    sections: new Map(sections.map((s) => [`${s.classId}|${normKey(s.name)}`, s.id])),
    subjects: new Map(subjects.flatMap((s) => [[normKey(s.name), s.id], [normKey(s.code), s.id]] as [string, string][])),
    topics: new Map(topics.map((t) => [`${t.subjectId}|${normKey(t.name)}`, t.id])),
    today: new Date().toISOString().slice(0, 10),
  };
}

/** Excel strips leading zeros from numeric-looking phone cells: 8031234567 → restore the 0. */
export function normalisePhoneCell(raw: string): string | null {
  const d = raw.replace(/[^\d+]/g, "");
  if (!d) return null;
  if (/^\+?234\d{10}$/.test(d)) return `0${d.replace("+", "").slice(3)}`;
  if (/^0\d{10}$/.test(d)) return d;
  if (/^\d{10}$/.test(d)) return `0${d}`;
  return null;
}

const yes = (s: string) => /^(y|yes|true|1)$/i.test(s.trim());

function issue(errors: RowError[], field: string, code: string, message: string) {
  errors.push({ field, code, message });
}

export interface ImportKindDef<T = Record<string, unknown>> {
  key: string;
  label: string;
  permission: string;
  columns: ColumnDef[];
  validateRow(raw: Record<string, string>, ref: RefData): { data?: T; errors: RowError[] };
  naturalKey(data: T): string;
  /** natural keys that already exist in the database (for duplicate detection). */
  findExisting(keys: T[]): Promise<Map<string, string>>;
  /** Expensive pre-work done OUTSIDE the transaction (password hashing). */
  prepare?(data: T): Promise<Record<string, unknown>>;
  commitRow(tx: Tx, ctx: SecurityContext, data: T, prepared: Record<string, unknown>): Promise<{ entityId: string; credentials?: { username: string; password: string; role: string; name: string }[] }>;
}

// ───────────── Students (+ guardians) ─────────────

const StudentRow = z.object({
  firstName: z.string(), middleName: z.string().optional(), lastName: z.string(), gender: z.enum(["MALE", "FEMALE"]), dateOfBirth: z.string().optional(),
  classId: z.string().uuid(), className: z.string(), sectionId: z.string().uuid().nullable(), stateOfOrigin: z.string().optional(), lga: z.string().optional(), religion: z.string().optional(),
  address: z.string().optional(), phone: z.string().optional(), admissionNumber: z.string().optional(),
  guardianName: z.string().optional(), guardianPhone: z.string().optional(), guardianEmail: z.string().optional(), guardianRelationship: z.string().optional(),
  createLogin: z.boolean(), password: z.string().optional(),
});
type StudentRowData = z.infer<typeof StudentRow>;

export const studentsKind: ImportKindDef<StudentRowData> = {
  key: "STUDENTS",
  label: "Students (with guardians)",
  permission: "students.create",
  columns: [
    { key: "firstName", label: "First name", aliases: ["firstname", "given name"], required: true, example: "Chidinma" },
    { key: "middleName", label: "Middle name", example: "Grace" },
    { key: "lastName", label: "Last name", aliases: ["surname", "family name"], required: true, example: "Okafor" },
    { key: "gender", label: "Gender", aliases: ["sex"], required: true, example: "Female", help: "Male or Female (M/F accepted)" },
    { key: "dateOfBirth", label: "Date of birth", aliases: ["dob", "birthdate"], example: "2014-05-12", help: "YYYY-MM-DD" },
    { key: "className", label: "Class", aliases: ["class name", "form"], required: true, example: "JSS 1", help: "Must match an existing class" },
    { key: "section", label: "Section", aliases: ["arm"], example: "A" },
    { key: "admissionNumber", label: "Admission number", aliases: ["admission no", "reg no"], help: "Leave blank to auto-generate" },
    { key: "stateOfOrigin", label: "State of origin", example: "Anambra" },
    { key: "lga", label: "LGA", example: "Awka South" },
    { key: "religion", label: "Religion", example: "Christianity" },
    { key: "address", label: "Address" },
    { key: "phone", label: "Student phone" },
    { key: "guardianName", label: "Guardian name", aliases: ["parent name", "parent"], example: "Ngozi Okafor" },
    { key: "guardianPhone", label: "Guardian phone", aliases: ["parent phone"], example: "08031234567", help: "Required when a guardian name is given. Siblings sharing a phone share one parent account." },
    { key: "guardianEmail", label: "Guardian email", aliases: ["parent email"], example: "ngozi@example.com" },
    { key: "guardianRelationship", label: "Relationship", example: "Mother" },
    { key: "createLogin", label: "Create student login", example: "no", help: "yes/no. Needed for CBT." },
    { key: "password", label: "Password", help: "Optional. If blank, a random temporary password is generated." },
  ],
  validateRow(raw, ref) {
    const errors: RowError[] = [];
    const first = raw.firstName?.trim(), last = raw.lastName?.trim();
    if (!first) issue(errors, "firstName", "REQUIRED", "First name is required");
    if (!last) issue(errors, "lastName", "REQUIRED", "Last name is required");
    const g = (raw.gender ?? "").trim().toLowerCase();
    const gender = /^(m|male|boy)$/.test(g) ? "MALE" : /^(f|female|girl)$/.test(g) ? "FEMALE" : null;
    if (!gender) issue(errors, "gender", "INVALID", "Gender must be Male or Female");
    let dob: string | undefined;
    if (raw.dateOfBirth) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.dateOfBirth) || Number.isNaN(Date.parse(raw.dateOfBirth))) issue(errors, "dateOfBirth", "INVALID_DATE", "Use the format YYYY-MM-DD");
      else if (raw.dateOfBirth > ref.today) issue(errors, "dateOfBirth", "FUTURE_DATE", "Date of birth cannot be in the future");
      else {
        const age = (Date.parse(ref.today) - Date.parse(raw.dateOfBirth)) / (365.25 * 86_400_000);
        if (age < 2 || age > 30) issue(errors, "dateOfBirth", "IMPLAUSIBLE", `Age ${Math.floor(age)} is outside the expected range (2–30)`);
        else dob = raw.dateOfBirth;
      }
    }
    const cls = ref.classes.get(normKey(raw.className ?? ""));
    if (!raw.className) issue(errors, "className", "REQUIRED", "Class is required");
    else if (!cls) issue(errors, "className", "UNKNOWN_CLASS", `Class "${raw.className}" does not exist`);
    let sectionId: string | null = null;
    if (raw.section && cls) {
      sectionId = ref.sections.get(`${cls.id}|${normKey(raw.section)}`) ?? null;
      if (!sectionId) issue(errors, "section", "UNKNOWN_SECTION", `Section "${raw.section}" does not exist in ${cls.name}`);
    }
    const gName = raw.guardianName?.trim(), gPhoneRaw = raw.guardianPhone?.trim();
    let gPhone: string | null = null;
    if (gPhoneRaw) { gPhone = normalisePhoneCell(gPhoneRaw); if (!gPhone) issue(errors, "guardianPhone", "INVALID_PHONE", "Guardian phone is not a valid Nigerian number"); }
    if (gName && !gPhoneRaw) issue(errors, "guardianPhone", "REQUIRED", "A guardian phone number is required when a guardian is given");
    if (gPhoneRaw && !gName) issue(errors, "guardianName", "REQUIRED", "Guardian name is required when a phone is given");
    if (raw.guardianEmail && !z.string().email().safeParse(raw.guardianEmail).success) issue(errors, "guardianEmail", "INVALID_EMAIL", "Guardian email is not valid");
    const createLogin = raw.createLogin ? yes(raw.createLogin) : false;
    if (raw.password) {
      try { assertPasswordPolicy(raw.password); } catch (e) { issue(errors, "password", "WEAK_PASSWORD", (e as Error).message); }
      if (!createLogin) issue(errors, "password", "NO_LOGIN", "A password was given but 'Create student login' is not yes");
    }
    let studentPhone: string | undefined;
    if (raw.phone) { studentPhone = normalisePhoneCell(raw.phone) ?? undefined; if (!studentPhone) issue(errors, "phone", "INVALID_PHONE", "Student phone is not a valid Nigerian number"); }
    if (errors.length || !cls || !gender) return { errors };
    return {
      errors,
      data: {
        firstName: first!, middleName: raw.middleName?.trim() || undefined, lastName: last!, gender, dateOfBirth: dob, classId: cls.id, className: cls.name, sectionId,
        stateOfOrigin: raw.stateOfOrigin?.trim() || undefined, lga: raw.lga?.trim() || undefined, religion: raw.religion?.trim() || undefined, address: raw.address?.trim() || undefined, phone: studentPhone,
        admissionNumber: raw.admissionNumber?.trim() || undefined, guardianName: gName || undefined, guardianPhone: gPhone ?? undefined, guardianEmail: raw.guardianEmail?.trim().toLowerCase() || undefined,
        guardianRelationship: raw.guardianRelationship?.trim() || "Guardian", createLogin, password: raw.password || undefined,
      },
    };
  },
  naturalKey: (d) => (d.admissionNumber ? `adm:${normKey(d.admissionNumber)}` : `name:${normKey(d.firstName)}|${normKey(d.lastName)}|${d.dateOfBirth ?? ""}`),
  async findExisting(rows) {
    const out = new Map<string, string>();
    const adms = rows.filter((r) => r.admissionNumber).map((r) => r.admissionNumber!);
    if (adms.length) for (const s of await db.studentProfile.findMany({ where: { admissionNumber: { in: adms } }, select: { admissionNumber: true } })) out.set(`adm:${normKey(s.admissionNumber)}`, `Admission number ${s.admissionNumber} already exists`);
    const byName = rows.filter((r) => !r.admissionNumber && r.dateOfBirth);
    if (byName.length) {
      const found = await db.studentProfile.findMany({ where: { deletedAt: null, OR: byName.map((r) => ({ firstName: { equals: r.firstName, mode: "insensitive" as const }, lastName: { equals: r.lastName, mode: "insensitive" as const }, dateOfBirth: new Date(`${r.dateOfBirth}T00:00:00Z`) })) }, select: { firstName: true, lastName: true, dateOfBirth: true, admissionNumber: true } });
      for (const s of found) out.set(`name:${normKey(s.firstName)}|${normKey(s.lastName)}|${s.dateOfBirth?.toISOString().slice(0, 10)}`, `A student with the same name and birth date already exists (${s.admissionNumber})`);
    }
    return out;
  },
  async prepare(d) {
    return d.password ? { passwordHash: await hashPassword(d.password) } : {};
  },
  async commitRow(tx, ctx, d, prepared) {
    let guardians: Parameters<typeof createStudentTx>[2]["guardians"] = [];
    if (d.guardianName && d.guardianPhone) {
      const existing = await findParentByPhone(tx, d.guardianPhone);
      const [gFirst, ...gRest] = d.guardianName.split(/\s+/);
      guardians = [existing
        ? { parentId: existing.id, relationship: d.guardianRelationship ?? "Guardian", isPrimary: true }
        : { newParent: { firstName: gFirst ?? "Guardian", lastName: gRest.join(" ") || d.lastName, phone: d.guardianPhone, email: d.guardianEmail }, relationship: d.guardianRelationship ?? "Guardian", isPrimary: true }];
    }
    const r = await createStudentTx(tx, ctx, {
      firstName: d.firstName, middleName: d.middleName, lastName: d.lastName, gender: d.gender, dateOfBirth: d.dateOfBirth, stateOfOrigin: d.stateOfOrigin, lga: d.lga, religion: d.religion,
      address: d.address, phone: d.phone, classId: d.classId, sectionId: d.sectionId, createLogin: d.createLogin, admissionNumber: d.admissionNumber, guardians,
    }, { presetPasswordHash: prepared.passwordHash as string | undefined });
    const credentials: { username: string; password: string; role: string; name: string }[] = [];
    if (r.username && r.initialPassword) credentials.push({ username: r.username, password: r.initialPassword, role: "Student", name: `${d.firstName} ${d.lastName}` });
    // a parent account created by this row must be handed its first password too (the parent shared by siblings appears once)
    for (const g of r.guardianCredentials) credentials.push({ username: g.username, password: g.initialPassword, role: "Parent", name: d.guardianName ?? "Parent" });
    return { entityId: r.student.id, credentials };
  },
};

// ───────────── Teachers ─────────────

const TeacherRow = z.object({ firstName: z.string(), lastName: z.string(), phone: z.string().optional(), email: z.string().optional(), qualification: z.string().optional(), specialization: z.string().optional(), employedOn: z.string().optional() });
type TeacherRowData = z.infer<typeof TeacherRow>;

export const teachersKind: ImportKindDef<TeacherRowData> = {
  key: "TEACHERS",
  label: "Teachers",
  permission: "teachers.manage",
  columns: [
    { key: "firstName", label: "First name", required: true, example: "Emeka" },
    { key: "lastName", label: "Last name", aliases: ["surname"], required: true, example: "Nwosu" },
    { key: "phone", label: "Phone", example: "08031234567" },
    { key: "email", label: "Email", example: "emeka@school.ng" },
    { key: "qualification", label: "Qualification", example: "B.Ed Mathematics" },
    { key: "specialization", label: "Specialization", aliases: ["subject"], example: "Mathematics" },
    { key: "employedOn", label: "Date employed", aliases: ["employment date"], example: "2020-09-01", help: "YYYY-MM-DD" },
  ],
  validateRow(raw, ref) {
    const errors: RowError[] = [];
    if (!raw.firstName?.trim()) issue(errors, "firstName", "REQUIRED", "First name is required");
    if (!raw.lastName?.trim()) issue(errors, "lastName", "REQUIRED", "Last name is required");
    if (raw.email && !z.string().email().safeParse(raw.email).success) issue(errors, "email", "INVALID_EMAIL", "Email is not valid");
    let phone: string | undefined;
    if (raw.phone) { phone = normalisePhoneCell(raw.phone) ?? undefined; if (!phone) issue(errors, "phone", "INVALID_PHONE", "Phone is not a valid Nigerian number"); }
    if (raw.employedOn && (!/^\d{4}-\d{2}-\d{2}$/.test(raw.employedOn) || Number.isNaN(Date.parse(raw.employedOn)) || raw.employedOn > ref.today)) issue(errors, "employedOn", "INVALID_DATE", "Use a past date in the format YYYY-MM-DD");
    if (errors.length) return { errors };
    return { errors, data: { firstName: raw.firstName!.trim(), lastName: raw.lastName!.trim(), phone, email: raw.email?.trim().toLowerCase() || undefined, qualification: raw.qualification?.trim() || undefined, specialization: raw.specialization?.trim() || undefined, employedOn: raw.employedOn || undefined } };
  },
  naturalKey: (d) => (d.email ? `mail:${d.email}` : `name:${normKey(d.firstName)}|${normKey(d.lastName)}|${d.phone ?? ""}`),
  async findExisting(rows) {
    const out = new Map<string, string>();
    const emails = rows.filter((r) => r.email).map((r) => r.email!);
    if (emails.length) for (const u of await db.user.findMany({ where: { email: { in: emails } }, select: { email: true } })) out.set(`mail:${u.email}`, `A user with email ${u.email} already exists`);
    return out;
  },
  async commitRow(tx, ctx, d) {
    const r = await createTeacherTx(tx, ctx, d);
    return { entityId: r.teacher.id, credentials: [{ username: r.username, password: r.initialPassword, role: "Teacher", name: `${d.firstName} ${d.lastName}` }] };
  },
};

// ───────────── CBT questions ─────────────

type QuestionRowData = z.infer<typeof QuestionInput> & { subjectName: string };

export const questionsKind: ImportKindDef<QuestionRowData> = {
  key: "QUESTIONS",
  label: "CBT / exam-prep questions",
  permission: "cbt.questions",
  columns: [
    { key: "subject", label: "Subject", required: true, example: "Mathematics", help: "Subject name or code" },
    { key: "topic", label: "Topic", example: "Algebra", help: "Must already exist for the subject (optional)" },
    { key: "examBody", label: "Exam body", aliases: ["exam"], example: "JAMB", help: "INTERNAL, WAEC, NECO, JAMB or BECE" },
    { key: "year", label: "Year", example: "2019" },
    { key: "difficulty", label: "Difficulty", example: "Medium", help: "Easy, Medium or Hard" },
    { key: "question", label: "Question", required: true, example: "Solve 2x + 3 = 11" },
    { key: "optionA", label: "Option A", required: true, example: "4" },
    { key: "optionB", label: "Option B", required: true, example: "5" },
    { key: "optionC", label: "Option C", example: "6" },
    { key: "optionD", label: "Option D", example: "7" },
    { key: "optionE", label: "Option E" },
    { key: "correct", label: "Correct answer", aliases: ["answer", "key"], required: true, example: "A", help: "Letter(s), e.g. A or A,C for multiple-answer questions" },
    { key: "explanation", label: "Explanation", example: "2x = 8, so x = 4" },
  ],
  validateRow(raw, ref) {
    const errors: RowError[] = [];
    const subjectId = ref.subjects.get(normKey(raw.subject ?? ""));
    if (!subjectId) issue(errors, "subject", "UNKNOWN_SUBJECT", `Subject "${raw.subject ?? ""}" does not exist`);
    let topicId: string | null = null;
    if (raw.topic && subjectId) { topicId = ref.topics.get(`${subjectId}|${normKey(raw.topic)}`) ?? null; if (!topicId) issue(errors, "topic", "UNKNOWN_TOPIC", `Topic "${raw.topic}" does not exist for this subject`); }
    const body = (raw.examBody || "INTERNAL").toUpperCase();
    if (!["INTERNAL", "WAEC", "NECO", "JAMB", "BECE"].includes(body)) issue(errors, "examBody", "INVALID", "Exam body must be INTERNAL, WAEC, NECO, JAMB or BECE");
    const diff = (raw.difficulty || "MEDIUM").toUpperCase();
    if (!["EASY", "MEDIUM", "HARD"].includes(diff)) issue(errors, "difficulty", "INVALID", "Difficulty must be Easy, Medium or Hard");
    const year = raw.year ? Number(raw.year) : null;
    if (raw.year && (!Number.isInteger(year) || year! < 1970 || year! > 2100)) issue(errors, "year", "INVALID", "Year must be between 1970 and 2100");
    const letters = "ABCDE".split("");
    const options = letters.map((l) => ({ label: l, text: (raw[`option${l}`] ?? "").trim() })).filter((o) => o.text);
    const correct = (raw.correct ?? "").toUpperCase().split(/[,\s/&]+/).filter(Boolean);
    if (!correct.length) issue(errors, "correct", "REQUIRED", "The correct answer is required");
    for (const c of correct) if (!options.some((o) => o.label === c)) issue(errors, "correct", "INVALID_KEY", `Correct answer "${c}" is not one of the options provided`);
    if (errors.length || !subjectId) return { errors };
    const parsed = QuestionInput.safeParse({
      subjectId, topicId, examBody: body, year, difficulty: diff, type: correct.length > 1 ? "MCQ_MULTIPLE" : "MCQ_SINGLE", stem: raw.question ?? "", explanation: raw.explanation || undefined,
      options: options.map((o) => ({ label: o.label, text: o.text, isCorrect: correct.includes(o.label) })),
    });
    if (!parsed.success) {
      for (const i of parsed.error.issues) issue(errors, String(i.path[0] ?? "question"), "INVALID", i.message);
      return { errors };
    }
    return { errors, data: { ...parsed.data, subjectName: raw.subject!.trim() } };
  },
  naturalKey: (d) => `${d.subjectId}|${normKey(d.stem)}`,
  async findExisting(rows) {
    const out = new Map<string, string>();
    if (!rows.length) return out;
    const found = await db.cBTQuestion.findMany({ where: { subjectId: { in: [...new Set(rows.map((r) => r.subjectId))] }, isActive: true }, select: { subjectId: true, stem: true } });
    const have = new Set(found.map((f) => `${f.subjectId}|${normKey(f.stem)}`));
    for (const r of rows) { const k = `${r.subjectId}|${normKey(r.stem)}`; if (have.has(k)) out.set(k, "This question is already in the bank"); }
    return out;
  },
  async commitRow(tx, ctx, d) {
    const { subjectName: _s, ...q } = d;
    const created = await createQuestionTx(tx, ctx, q, { audit: false });
    return { entityId: created.id };
  },
};

export const IMPORT_KINDS = { STUDENTS: studentsKind, TEACHERS: teachersKind, QUESTIONS: questionsKind } as unknown as Record<string, ImportKindDef>;
export function kindOrThrow(key: string): ImportKindDef {
  const k = IMPORT_KINDS[key];
  if (!k) throw new AppError("UNKNOWN_IMPORT_KIND", `Unknown import type "${key}"`, 400);
  return k;
}
void TeacherRow; void StudentRow;

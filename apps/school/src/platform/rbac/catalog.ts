/**
 * The permission catalog is code (so new permissions ship with new features) but authorization decisions
 * are data: roles ↔ permissions live in the database and the Primary Admin edits them at runtime.
 */
export const MODULES = [
  "platform", "students", "staff", "academics", "results", "admissions", "finance", "attendance",
  "timetable", "lessonnotes", "cbt", "examprep", "communication", "automation", "analytics",
  "reports", "imports", "sync", "backup",
] as const;
export type ModuleKey = (typeof MODULES)[number];

/** Modules that make up the always-on core; they cannot be switched off or unlicensed. */
export const CORE_MODULES: readonly ModuleKey[] = ["platform", "students", "staff", "academics"];

interface PermDef {
  module: ModuleKey;
  action: string;
  description: string;
}

const p = (module: ModuleKey, action: string, description: string): PermDef => ({ module, action, description });

export const PERMISSIONS: readonly PermDef[] = [
  // platform / users / rbac / settings
  p("platform", "users.view", "View user accounts"),
  p("platform", "users.create", "Create user accounts"),
  p("platform", "users.edit", "Edit user accounts"),
  p("platform", "users.disable", "Disable / re-enable user accounts"),
  p("platform", "users.reset_password", "Reset another user's password"),
  p("platform", "roles.view", "View roles and permissions"),
  p("platform", "roles.manage", "Create roles and edit their permissions"),
  p("platform", "settings.view", "View school settings"),
  p("platform", "settings.edit", "Edit school profile, branding and policies"),
  p("platform", "modules.manage", "Enable or disable modules and feature toggles"),
  p("platform", "audit.view", "View the audit log"),
  p("platform", "license.view", "View license and installation status"),
  // students
  p("students", "students.view", "View student records"),
  p("students", "students.create", "Create student records"),
  p("students", "students.edit", "Edit student records"),
  p("students", "students.delete", "Withdraw / archive students"),
  p("students", "guardians.manage", "Manage guardians and parent links"),
  p("students", "enrollment.manage", "Enroll students into classes"),
  // staff
  p("staff", "teachers.view", "View teacher records"),
  p("staff", "teachers.manage", "Create and edit teacher and staff records"),
  p("staff", "staff.view", "View non-teaching staff records"),
  p("staff", "staff_attendance.record", "Record staff attendance"),
  // academics structure
  p("academics", "academics.view", "View years, terms, classes, subjects"),
  p("academics", "academics.manage", "Manage years, terms, classes, sections, subjects, curriculum"),
  p("academics", "class_subjects.manage", "Assign subjects and teachers to classes"),
  // results
  p("results", "assessments.view", "View assessments and scores"),
  p("results", "assessments.enter_scores", "Enter CA / exam scores for own classes"),
  p("results", "assessments.enter_any", "Enter scores for any class"),
  p("results", "grading.manage", "Configure grading schemes and components"),
  p("results", "results.view", "View processed results"),
  p("results", "results.process", "Run result processing"),
  p("results", "results.edit", "Edit processed results / remarks"),
  p("results", "results.publish", "Publish and withdraw results"),
  p("results", "results.bypass_lockout", "View results despite a financial lockout"),
  p("results", "promotion.manage", "Run and edit promotions"),
  // admissions
  p("admissions", "admissions.view", "View admission applications"),
  p("admissions", "admissions.review", "Review, verify, approve or reject applications"),
  p("admissions", "admissions.enroll", "Convert approved applicants into students"),
  // finance
  p("finance", "finance.view", "View fees, invoices, payments"),
  p("finance", "finance.manage_fees", "Manage fee structures, discounts and scholarships"),
  p("finance", "finance.create_invoice", "Generate and issue invoices"),
  p("finance", "finance.create_payment", "Record payments"),
  p("finance", "finance.reverse_payment", "Reverse payments"),
  p("finance", "finance.void_invoice", "Void invoices"),
  p("finance", "finance.expenses", "Record and view expenses"),
  p("finance", "finance.reports", "View financial reports and the ledger"),
  p("finance", "finance.configure_lockout", "Configure the financial lockout policy"),
  // attendance
  p("attendance", "attendance.view", "View attendance"),
  p("attendance", "attendance.record", "Record attendance for own classes"),
  p("attendance", "attendance.record_any", "Record attendance for any class"),
  p("attendance", "attendance.devices", "Manage attendance devices"),
  // timetable
  p("timetable", "timetable.view", "View timetables"),
  p("timetable", "timetable.manage", "Create and edit timetables and rooms"),
  // lesson notes
  p("lessonnotes", "lessonnotes.view", "View published lesson notes"),
  p("lessonnotes", "lessonnotes.manage_own", "Create and edit own lesson notes"),
  p("lessonnotes", "lessonnotes.manage_any", "Edit or unpublish any lesson note"),
  // cbt
  p("cbt", "cbt.view", "View CBT exams"),
  p("cbt", "cbt.questions", "Manage the question bank"),
  p("cbt", "cbt.create_exam", "Create CBT exams"),
  p("cbt", "cbt.start_exam", "Open, schedule and close CBT exams"),
  p("cbt", "cbt.review_attempt", "Review student attempts"),
  p("cbt", "cbt.publish_result", "Publish CBT results"),
  p("cbt", "cbt.take", "Sit CBT exams (students)"),
  // exam prep
  p("examprep", "examprep.practice", "Use WAEC / NECO / JAMB / BECE practice (students)"),
  p("examprep", "examprep.manage", "Manage exam-prep question sets"),
  // communication
  p("communication", "announcements.view", "View announcements"),
  p("communication", "announcements.manage", "Publish announcements"),
  p("communication", "notifications.manage", "Manage templates and providers"),
  // automation
  p("automation", "automation.view", "View automation rules and logs"),
  p("automation", "automation.manage", "Create and edit automation rules"),
  // analytics / reports
  p("analytics", "analytics.view", "View analytics dashboards"),
  p("reports", "reports.generate", "Generate and download reports"),
  // imports
  p("imports", "imports.run", "Run Excel imports"),
  // sync / backup
  p("sync", "sync.view", "View synchronization status"),
  p("sync", "sync.resolve_conflicts", "Resolve synchronization conflicts"),
  p("backup", "backup.view", "View backups"),
  p("backup", "backup.run", "Run backups"),
  p("backup", "backup.restore", "Restore from a backup"),
  // parent / student self-service (scope-checked at the resource level)
  p("students", "self.view", "View own / own children's information"),
];


export interface RoleDef {
  key: string;
  name: string;
  description: string;
  isProtected?: boolean;
  /** "*" = every permission (kept in sync as the catalog grows). */
  permissions: readonly string[] | "*";
}

export const DEFAULT_ROLES: readonly RoleDef[] = [
  { key: "primary_admin", name: "Primary Admin", description: "Owner of the school installation", isProtected: true, permissions: "*" },
  {
    key: "principal", name: "Principal", description: "Head of school: oversight of every academic and financial area",
    permissions: [
      "students.view", "teachers.view", "staff.view", "academics.view", "assessments.view", "results.view", "results.publish",
      "results.edit", "results.process", "results.bypass_lockout", "promotion.manage", "admissions.view", "admissions.review",
      "finance.view", "finance.reports", "attendance.view", "timetable.view", "cbt.view", "cbt.review_attempt", "cbt.publish_result",
      "announcements.view", "announcements.manage", "analytics.view", "reports.generate", "automation.view", "audit.view",
      "users.view", "lessonnotes.view", "lessonnotes.manage_any", "sync.view",
    ],
  },
  {
    key: "registrar", name: "Registrar", description: "Admissions, student records and enrollment",
    permissions: [
      "students.view", "students.create", "students.edit", "guardians.manage", "enrollment.manage", "academics.view",
      "admissions.view", "admissions.review", "admissions.enroll", "imports.run", "reports.generate", "attendance.view",
      "announcements.view", "teachers.view",
    ],
  },
  {
    key: "bursar", name: "Bursar", description: "Fees, payments and financial reporting",
    permissions: [
      "students.view", "academics.view", "finance.view", "finance.manage_fees", "finance.create_invoice", "finance.create_payment",
      "finance.reverse_payment", "finance.void_invoice", "finance.expenses", "finance.reports", "finance.configure_lockout",
      "reports.generate", "analytics.view", "announcements.view", "backup.view",
    ],
  },
  {
    key: "teacher", name: "Teacher", description: "Classroom teaching, scores, attendance, lesson notes, CBT",
    permissions: [
      "students.view", "teachers.view", "academics.view", "assessments.view", "assessments.enter_scores", "results.view",
      "attendance.view", "attendance.record", "timetable.view", "lessonnotes.view", "lessonnotes.manage_own",
      "cbt.view", "cbt.questions", "cbt.create_exam", "cbt.start_exam", "cbt.review_attempt", "announcements.view", "reports.generate",
    ],
  },
  {
    key: "staff", name: "Staff", description: "Non-teaching staff",
    permissions: ["staff.view", "announcements.view", "self.view"],
  },
  {
    key: "parent", name: "Parent / Guardian", description: "Parent portal (scoped to own children)",
    permissions: ["self.view", "announcements.view", "results.view", "finance.view", "attendance.view", "lessonnotes.view", "cbt.view"],
  },
  {
    key: "student", name: "Student", description: "Student self-service, CBT and exam practice",
    permissions: ["self.view", "announcements.view", "results.view", "lessonnotes.view", "cbt.view", "cbt.take", "examprep.practice"],
  },
];

export function permissionKeys(): string[] {
  return PERMISSIONS.map((x) => x.action);
}

import type { IconName } from "@/ui/icons";

export interface NavItem {
  label: string;
  href: string;
  icon: IconName;
  /** Module that must be enabled (server-computed list from /auth/me). */
  module?: string;
  /** Visible when the user holds ANY of these permissions (visibility only — the API enforces the real check). */
  perm?: string[];
  /** Restrict to user types. */
  types?: string[];
}
export interface NavGroup { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  { label: "Overview", items: [
    { label: "Dashboard", href: "/dashboard", icon: "home", perm: ["analytics.view", "students.view", "finance.view"] },
    { label: "My classes", href: "/teach", icon: "school", types: ["TEACHER"] },
    { label: "Announcements", href: "/announcements", icon: "bell", module: "communication", perm: ["announcements.view"] },
  ] },
  { label: "People", items: [
    { label: "Students", href: "/students", icon: "users", module: "students", perm: ["students.view"] },
    { label: "Teachers & staff", href: "/staff", icon: "user", module: "staff", perm: ["teachers.view", "staff.view"] },
    { label: "Admissions", href: "/admissions", icon: "file", module: "admissions", perm: ["admissions.view"] },
    { label: "Import from Excel", href: "/imports", icon: "upload", module: "imports", perm: ["imports.run"] },
  ] },
  { label: "Teaching", items: [
    { label: "Attendance", href: "/attendance", icon: "check", module: "attendance", perm: ["attendance.record", "attendance.record_any", "attendance.view"] },
    { label: "Score entry", href: "/results/scores", icon: "edit", module: "results", perm: ["assessments.enter_scores", "assessments.enter_any"] },
    { label: "Results", href: "/results", icon: "target", module: "results", perm: ["results.process", "results.publish", "results.view"], types: ["ADMIN", "TEACHER", "STAFF"] },
    { label: "Timetable", href: "/timetable", icon: "calendar", module: "timetable", perm: ["timetable.view"] },
    { label: "Lesson notes", href: "/lesson-notes", icon: "book", module: "lessonnotes", perm: ["lessonnotes.manage_own", "lessonnotes.manage_any"] },
    { label: "Classes & subjects", href: "/academics", icon: "layers", perm: ["academics.view"] },
  ] },
  { label: "Exams", items: [
    { label: "CBT exams", href: "/cbt", icon: "grid", module: "cbt", perm: ["cbt.create_exam", "cbt.questions", "cbt.review_attempt"] },
    { label: "Question bank", href: "/cbt/questions", icon: "book", module: "cbt", perm: ["cbt.questions"] },
  ] },
  { label: "Finance", items: [
    { label: "Fees & payments", href: "/finance", icon: "wallet", module: "finance", perm: ["finance.view"], types: ["ADMIN", "STAFF", "TEACHER"] },
    { label: "Invoices", href: "/finance/invoices", icon: "file", module: "finance", perm: ["finance.view"], types: ["ADMIN", "STAFF", "TEACHER"] },
    { label: "Expenses", href: "/finance/expenses", icon: "minus", module: "finance", perm: ["finance.expenses"] },
  ] },
  { label: "Insight", items: [
    { label: "Analytics", href: "/analytics", icon: "chart", module: "analytics", perm: ["analytics.view"] },
    { label: "Reports", href: "/reports", icon: "print", module: "reports", perm: ["reports.generate"] },
    { label: "Communication", href: "/communication", icon: "mail", module: "communication", perm: ["notifications.manage", "announcements.manage"] },
    { label: "Automation", href: "/automation", icon: "bolt", module: "automation", perm: ["automation.view"] },
  ] },
  { label: "Administration", items: [
    { label: "School settings", href: "/admin/school", icon: "settings", perm: ["settings.view"] },
    { label: "Users & roles", href: "/admin/users", icon: "key", perm: ["users.view", "roles.view"] },
    { label: "Modules & features", href: "/admin/modules", icon: "layers", perm: ["modules.manage"] },
    { label: "Backup", href: "/admin/backup", icon: "database", module: "backup", perm: ["backup.view"] },
    { label: "Cloud & licence", href: "/admin/sync", icon: "cloud", perm: ["license.view", "sync.view"] },
    { label: "Audit log", href: "/admin/audit", icon: "shield", perm: ["audit.view"] },
  ] },
];

export const PORTAL_TABS: { label: string; href: string; icon: IconName }[] = [
  { label: "Overview", href: "/portal", icon: "home" },
  { label: "Results", href: "/portal/results", icon: "target" },
  { label: "Attendance", href: "/portal/attendance", icon: "check" },
  { label: "Fees", href: "/portal/fees", icon: "wallet" },
  { label: "More", href: "/portal/more", icon: "menu" },
];

/** Where each kind of person lands after signing in. */
export function homeFor(userType: string, perms: string[]): string {
  if (userType === "PARENT") return "/portal";
  if (userType === "STUDENT") return "/student";
  if (userType === "TEACHER") return "/teach";
  return perms.includes("analytics.view") || perms.includes("students.view") || perms.includes("finance.view") ? "/dashboard" : "/announcements";
}

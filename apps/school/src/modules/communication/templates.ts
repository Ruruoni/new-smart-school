import type { Tx } from "@/platform/db";
import { safeGet } from "@/platform/util";

/** {{placeholder}} substitution only — no expressions, no code, no HTML. Unknown placeholders render empty. */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    const v = safeGet(vars, key);
    return v === undefined || v === null || typeof v === "object" ? "" : String(v).replace(/[\r\n]+/g, " ").slice(0, 300);
  });
}

interface Tpl {
  key: string;
  subject: string;
  body: string;
}

/** Default wording per event. Schools edit these; they are only inserted when missing. */
export const DEFAULT_TEMPLATES: readonly Tpl[] = [
  { key: "attendance.absent", subject: "{{studentFirstName}} was absent today", body: "Dear parent/guardian, {{student}} ({{class}}) was marked absent on {{date}}. Please contact the school if this is unexpected. — {{school}}" },
  { key: "attendance.late", subject: "{{studentFirstName}} arrived late", body: "Dear parent/guardian, {{student}} ({{class}}) arrived late on {{date}}. — {{school}}" },
  { key: "attendance.repeated_absence", subject: "Repeated absence: {{student}}", body: "{{student}} ({{class}}) has now been absent {{absenceCount}} times this term. Please follow up. — {{school}}" },
  { key: "payment.received", subject: "Payment received: {{receipt}}", body: "Payment of ₦{{amount}} received for {{student}}. Receipt {{receipt}}. Thank you. — {{school}}" },
  { key: "invoice.issued", subject: "New invoice {{invoice}}", body: "An invoice of ₦{{total}} ({{invoice}}) has been issued for {{student}}, due {{dueDate}}. — {{school}}" },
  { key: "invoice.overdue", subject: "Fees overdue: {{student}}", body: "The invoice {{invoice}} for {{student}} (₦{{balance}} outstanding) was due on {{dueDate}}. Please pay at the bursary. — {{school}}" },
  { key: "result.published", subject: "Results published: {{student}}", body: "The {{term}} results for {{student}} are now available on the parent portal. — {{school}}" },
  { key: "admission.submitted", subject: "Application received: {{applicationNumber}}", body: "We have received the application for {{applicant}} ({{applicationNumber}}). We will contact you after review. — {{school}}" },
  { key: "admission.approved", subject: "Admission offered: {{applicant}}", body: "Congratulations! {{applicant}} has been offered admission ({{applicationNumber}}). The school will contact you with next steps. — {{school}}" },
  { key: "admission.rejected", subject: "Admission decision: {{applicant}}", body: "Thank you for applying. We are unable to offer {{applicant}} a place at this time ({{applicationNumber}}). — {{school}}" },
  { key: "exam.scheduled", subject: "Exam scheduled: {{title}}", body: "The CBT exam \"{{title}}\" is scheduled. Please be ready. — {{school}}" },
  { key: "cbt.result_available", subject: "CBT result available", body: "The result for \"{{title}}\" is available ({{percentage}}%). — {{school}}" },
  { key: "announcement.published", subject: "{{title}}", body: "{{body}} — {{school}}" },
];

export async function seedTemplates(tx: Tx) {
  for (const t of DEFAULT_TEMPLATES) {
    for (const channel of ["IN_APP", "EMAIL", "SMS", "WHATSAPP"] as const) {
      await tx.notificationTemplate.upsert({
        where: { key_channel: { key: t.key, channel } },
        create: { key: t.key, channel, subject: channel === "EMAIL" || channel === "IN_APP" ? t.subject : null, body: t.body },
        update: {},
      });
    }
  }
}

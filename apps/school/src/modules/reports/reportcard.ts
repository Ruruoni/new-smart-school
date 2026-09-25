import { db } from "@/platform/db";
import type { SecurityContext } from "@/platform/security/context";
import { getReportCard } from "@/modules/results/service";
import { ordinal } from "@/modules/results/engine";
import { readFileBuffer } from "@/platform/files";
import { collect, fmt, newPdf, pageFooters } from "./render";

type Card = Awaited<ReturnType<typeof getReportCard>>;

const TEAL = "#0f4c5c";
const INK = "#1d2a33";
const MUTED = "#5b6b76";
const LINE = "#cfd9de";

async function logoBuffer(fileId: string | null): Promise<Buffer | null> {
  if (!fileId) return null;
  try {
    const { data, asset } = await readFileBuffer(fileId);
    return asset.mimeType === "image/png" || asset.mimeType === "image/jpeg" ? data : null;
  } catch {
    return null;
  }
}

/** One report-card page. Pure layout: everything shown was already authorised and lockout-checked by getReportCard. */
export function drawCard(doc: PDFKit.PDFDocument, c: Card, logo: Buffer | null) {
  const W = doc.page.width - 72;
  const left = 36;
  let y = 36;
  const draft = c.card.status !== "PUBLISHED";

  if (logo) { try { doc.image(logo, left, y, { fit: [54, 54] }); } catch { /* unreadable logo: skip */ } }
  const tx = logo ? left + 64 : left;
  doc.font("Bold").fontSize(16).fillColor(TEAL).text(c.school.schoolName, tx, y, { width: W - (tx - left) });
  doc.font("Body").fontSize(8.5).fillColor(MUTED).text([c.school.address, c.school.phone, c.school.email].filter(Boolean).join(" · "), tx, doc.y, { width: W - (tx - left) });
  if (c.school.motto) doc.font("Italic").fontSize(8.5).text(`“${c.school.motto}”`, tx, doc.y, { width: W - (tx - left) });
  y = Math.max(doc.y, y + 58) + 6;
  doc.moveTo(left, y).lineTo(left + W, y).lineWidth(1.5).strokeColor(TEAL).stroke();
  y += 10;
  doc.font("Bold").fontSize(12).fillColor(INK).text("STUDENT'S TERMINAL REPORT", left, y, { width: W, align: "center" });
  y += 18;
  if (draft) { doc.font("Bold").fontSize(8).fillColor("#b45309").text("DRAFT — NOT FOR DISTRIBUTION", left, y, { width: W, align: "center" }); y += 12; }

  // Student block
  const s = c.card.student;
  const info: [string, string][] = [
    ["Name", `${s.lastName}, ${s.firstName}${s.middleName ? ` ${s.middleName}` : ""}`], ["Admission No.", s.admissionNumber],
    ["Class", c.class], ["Term", `${c.card.term.name} — ${c.card.term.academicYear.name}`],
    ["Position", c.card.position ? `${ordinal(c.card.position)} of ${c.card.classSize}` : "—"], ["Average", `${c.card.average.toFixed(2)}%`],
  ];
  const colW = W / 2;
  info.forEach(([k, v], i) => {
    const cx = left + (i % 2) * colW, cy = y + Math.floor(i / 2) * 16;
    doc.font("Body").fontSize(8.5).fillColor(MUTED).text(k, cx, cy, { width: 80, lineBreak: false });
    doc.font("Bold").fontSize(9).fillColor(INK).text(v, cx + 84, cy, { width: colW - 90, lineBreak: false, ellipsis: true });
  });
  y += Math.ceil(info.length / 2) * 16 + 8;

  // Subject table
  const cols = [{ label: "Subject", w: 0.34, a: "left" }, { label: "CA", w: 0.1, a: "right" }, { label: "Exam", w: 0.1, a: "right" }, { label: "Total", w: 0.1, a: "right" }, { label: "Grade", w: 0.08, a: "center" }, { label: "Pos.", w: 0.07, a: "center" }, { label: "Class avg", w: 0.09, a: "right" }, { label: "Remark", w: 0.12, a: "left" }] as const;
  const widths = cols.map((x) => x.w * W);
  const head = (yy: number) => {
    doc.rect(left, yy, W, 18).fill(TEAL);
    let x = left;
    cols.forEach((col, i) => { doc.font("Bold").fontSize(8).fillColor("#fff").text(col.label, x + 4, yy + 5, { width: widths[i]! - 8, align: col.a, lineBreak: false }); x += widths[i]!; });
    return yy + 18;
  };
  y = head(y);
  c.subjects.forEach((r, idx) => {
    if (idx % 2 === 0) doc.rect(left, y, W, 17).fill("#f1f6f8");
    const cells = [r.subject, fmt(r.caTotal, "text"), fmt(r.exam, "text"), fmt(r.total, "text"), r.grade, r.position ? ordinal(r.position) : "", r.classAverage === null ? "" : r.classAverage.toFixed(1), r.remark ?? ""];
    let x = left;
    cells.forEach((v, i) => { doc.font(i === 3 || i === 4 ? "Bold" : "Body").fontSize(8.5).fillColor(INK).text(String(v), x + 4, y + 4.5, { width: widths[i]! - 8, align: cols[i]!.a, lineBreak: false, ellipsis: true }); x += widths[i]!; });
    y += 17;
  });
  doc.rect(left, y, W, 0).lineWidth(0.5).strokeColor(LINE).stroke();
  y += 10;

  // Summary
  const sum: [string, string][] = [["Total score", c.card.totalScore.toFixed(2)], ["Average", `${c.card.average.toFixed(2)}%`], ["Subjects", String(c.card.subjectsCount)], ...(c.card.cumulativeAverage !== null ? [["Cumulative average", `${c.card.cumulativeAverage.toFixed(2)}%`] as [string, string]] : [])];
  const att = c.card.attendanceSummary as { present?: number; late?: number; absent?: number; daysRecorded?: number; rate?: number | null } | null;
  if (att?.daysRecorded) sum.push(["Attendance", `${att.present! + (att.late ?? 0)} of ${att.daysRecorded} days${att.rate != null ? ` (${att.rate}%)` : ""}`]);
  sum.forEach(([k, v], i) => { const cx = left + (i % 3) * (W / 3); const cy = y + Math.floor(i / 3) * 30; doc.font("Body").fontSize(8).fillColor(MUTED).text(k, cx, cy, { width: W / 3 - 6 }); doc.font("Bold").fontSize(11).fillColor(TEAL).text(v, cx, cy + 10, { width: W / 3 - 6 }); });
  y += Math.ceil(sum.length / 3) * 30 + 6;

  // Remarks + signatures
  const remark = (label: string, text: string | null) => { doc.font("Bold").fontSize(8.5).fillColor(INK).text(label, left, y); doc.font("Body").fontSize(8.5).fillColor(INK).text(text || "—", left, doc.y + 1, { width: W }); y = doc.y + 8; };
  remark("Class teacher's remark", c.card.teacherRemark);
  remark("Principal's remark", c.card.principalRemark);
  const sigY = y + 18;
  doc.moveTo(left, sigY).lineTo(left + 150, sigY).lineWidth(0.5).strokeColor(MUTED).stroke();
  doc.moveTo(left + W - 150, sigY).lineTo(left + W, sigY).stroke();
  doc.font("Body").fontSize(8).fillColor(MUTED).text("Class teacher", left, sigY + 3).text(c.branding.principalName ? `Principal — ${c.branding.principalName}` : "Principal", left + W - 150, sigY + 3, { width: 150, align: "right" });
  y = sigY + 24;

  // Grade key
  doc.font("Bold").fontSize(7.5).fillColor(MUTED).text("Grading key: ", left, y, { continued: true }).font("Body").text(c.gradeKey.map((g) => `${g.grade} ${g.range}${g.remark ? ` (${g.remark})` : ""}`).join("   "), { width: W });
  if (c.branding.reportCardFooter) doc.font("Italic").fontSize(7.5).text(c.branding.reportCardFooter, left, doc.y + 4, { width: W, align: "center" });
}

export async function reportCardPdf(cards: Card[]): Promise<Buffer> {
  const doc = newPdf(false);
  const logo = await logoBuffer(cards[0]?.school.logoFileId ?? null);
  cards.forEach((c, i) => { if (i) doc.addPage(); drawCard(doc, c, logo); });
  pageFooters(doc, `${cards[0]?.school.schoolName ?? ""} · Terminal report`);
  return collect(doc);
}

/** Every student in a class for a term (staff bulk print). Skips students that have no processed card. */
export async function classReportCards(ctx: SecurityContext, termId: string, classId: string, includeDraft: boolean): Promise<Card[]> {
  const cards = await db.reportCard.findMany({ where: { termId, classId, ...(includeDraft ? {} : { status: "PUBLISHED" as const }) }, orderBy: { position: "asc" }, select: { studentId: true } });
  const out: Card[] = [];
  for (const c of cards) out.push(await getReportCard(ctx, c.studentId, termId));
  return out;
}

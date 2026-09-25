import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

export interface Column {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  /** Relative width weight for PDF/XLSX layout. */
  width?: number;
  /** Formatting hint: money uses ₦ and thousands separators. */
  format?: "money" | "percent" | "date" | "integer" | "text";
}

export interface ReportData {
  title: string;
  subtitle?: string;
  school?: string;
  generatedAt?: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  summary?: { label: string; value: string }[];
  footnote?: string;
}

/**
 * Locate the bundled Unicode font at RUNTIME (a static `require.resolve("…/x.ttf")` would make the bundler try to
 * compile the .ttf). Tries the app's node_modules first (Docker/standalone), then normal package resolution.
 */
let fontDir: string | undefined;
function resolveFontDir(): string {
  if (fontDir) return fontDir;
  const candidates = [join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf")];
  try { candidates.push(join(dirname(createRequire(join(process.cwd(), "package.json")).resolve("dejavu-fonts-ttf/package.json")), "ttf")); } catch { /* not resolvable */ }
  for (const c of candidates) if (existsSync(join(c, "DejaVuSans.ttf"))) return (fontDir = c);
  throw new Error("The report font (dejavu-fonts-ttf) is not installed");
}
export const fontPath = (name: "DejaVuSans" | "DejaVuSans-Bold" | "DejaVuSans-Oblique") => join(resolveFontDir(), `${name}.ttf`);

const nf = new Intl.NumberFormat("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ni = new Intl.NumberFormat("en-NG");

export function fmt(v: unknown, format: Column["format"] = "text"): string {
  if (v === null || v === undefined || v === "") return "";
  switch (format) {
    case "money": return `₦${nf.format(Number(v))}`;
    case "percent": return `${Number(v).toFixed(1)}%`;
    case "integer": return ni.format(Number(v));
    case "date": { const d = v instanceof Date ? v : new Date(String(v)); return Number.isNaN(d.getTime()) ? String(v) : `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; }
    default: return String(v);
  }
}

// ───────────── CSV (UTF-8 with BOM so Excel shows ₦ and accents correctly) ─────────────

/** Neutralise spreadsheet formula injection: a cell that starts with = + - @ is treated as text by Excel. */
export function csvSafe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
}

export function toCsv(r: ReportData): Buffer {
  const esc = (v: string) => `"${csvSafe(v).replace(/"/g, '""')}"`;
  const lines = [r.columns.map((c) => esc(c.label)).join(","), ...r.rows.map((row) => r.columns.map((c) => esc(c.format === "money" || c.format === "percent" || c.format === "integer" ? (row[c.key] === null || row[c.key] === undefined ? "" : String(row[c.key])) : fmt(row[c.key], c.format))).join(","))];
  return Buffer.from("﻿" + lines.join("\r\n") + "\r\n", "utf8");
}

// ───────────── XLSX ─────────────

export async function toXlsx(r: ReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = r.school ?? "SmartSchool";
  const ws = wb.addWorksheet(r.title.slice(0, 30).replace(/[\\/*?:[\]]/g, " "));
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  if (r.subtitle) ws.addRow([r.subtitle]).font = { italic: true };
  ws.addRow([]);
  const headerRow = ws.addRow(r.columns.map((c) => c.label));
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F4C5C" } };
  const headerIdx = headerRow.number;
  for (const row of r.rows) {
    const cells = r.columns.map((c) => {
      const v = row[c.key];
      if (v === null || v === undefined) return null;
      if (c.format === "money" || c.format === "percent" || c.format === "integer") return Number(v);
      if (c.format === "date") return fmt(v, "date");
      const s = String(v);
      return /^[=+\-@]/.test(s) ? `'${s}` : s; // formula-injection guard
    });
    ws.addRow(cells);
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(10, Math.min(45, (c.width ?? 1) * 14));
    col.alignment = { horizontal: c.align ?? (c.format === "money" || c.format === "percent" || c.format === "integer" ? "right" : "left") };
    if (c.format === "money") col.numFmt = '"₦"#,##0.00';
    if (c.format === "percent") col.numFmt = '0.0"%"';
    if (c.format === "integer") col.numFmt = "#,##0";
  });
  ws.views = [{ state: "frozen", ySplit: headerIdx }];
  ws.autoFilter = { from: { row: headerIdx, column: 1 }, to: { row: headerIdx, column: r.columns.length } };
  if (r.summary?.length) {
    ws.addRow([]);
    for (const s of r.summary) ws.addRow([s.label, s.value]).font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────────── PDF ─────────────

const TEAL = "#0f4c5c";
const INK = "#1d2a33";
const MUTED = "#5b6b76";

export function newPdf(landscape = false) {
  const doc = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 36, bufferPages: true, info: { Producer: "SmartSchool ERP" } });
  doc.registerFont("Body", fontPath("DejaVuSans"));
  doc.registerFont("Bold", fontPath("DejaVuSans-Bold"));
  doc.registerFont("Italic", fontPath("DejaVuSans-Oblique"));
  doc.font("Body");
  return doc;
}

export function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

export function pageFooters(doc: PDFKit.PDFDocument, left: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would make pdfkit append a blank page per page; lift the margin while stamping.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Body").fontSize(7.5).fillColor(MUTED);
    const y = doc.page.height - 26;
    doc.text(left, 36, y, { width: doc.page.width - 72, align: "left", lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, 36, y, { width: doc.page.width - 72, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

export async function toPdf(r: ReportData): Promise<Buffer> {
  const landscape = r.columns.length > 6;
  const doc = newPdf(landscape);
  const W = doc.page.width - 72;
  const totalWeight = r.columns.reduce((s, c) => s + (c.width ?? 1), 0);
  const widths = r.columns.map((c) => ((c.width ?? 1) / totalWeight) * W);
  const header = () => {
    doc.font("Bold").fontSize(15).fillColor(TEAL).text(r.school ?? "", 36, 36);
    doc.font("Bold").fontSize(12).fillColor(INK).text(r.title);
    if (r.subtitle) doc.font("Body").fontSize(9).fillColor(MUTED).text(r.subtitle);
    doc.moveDown(0.6);
  };
  const headRow = (y: number) => {
    doc.rect(36, y, W, 20).fill(TEAL);
    let x = 36;
    r.columns.forEach((c, i) => { doc.font("Bold").fontSize(8).fillColor("#ffffff").text(c.label, x + 4, y + 6, { width: widths[i]! - 8, align: c.align ?? "left", lineBreak: false, ellipsis: true }); x += widths[i]!; });
    return y + 20;
  };
  header();
  let y = headRow(doc.y);
  r.rows.forEach((row, idx) => {
    if (y > doc.page.height - 60) { doc.addPage(); y = headRow(36); }
    if (idx % 2 === 0) doc.rect(36, y, W, 18).fill("#f1f6f8");
    let x = 36;
    r.columns.forEach((c, i) => {
      const right = c.format === "money" || c.format === "percent" || c.format === "integer";
      doc.font("Body").fontSize(8).fillColor(INK).text(fmt(row[c.key], c.format), x + 4, y + 5, { width: widths[i]! - 8, align: c.align ?? (right ? "right" : "left"), lineBreak: false, ellipsis: true });
      x += widths[i]!;
    });
    y += 18;
  });
  if (!r.rows.length) doc.font("Italic").fontSize(9).fillColor(MUTED).text("No records match this report.", 36, y + 8);
  if (r.summary?.length) {
    y = Math.max(y, doc.y) + 14;
    if (y > doc.page.height - 100) { doc.addPage(); y = 36; }
    doc.font("Bold").fontSize(9).fillColor(TEAL).text("Summary", 36, y);
    y += 14;
    for (const s of r.summary) { doc.font("Body").fontSize(9).fillColor(MUTED).text(s.label, 36, y, { width: 220, lineBreak: false }); doc.font("Bold").fillColor(INK).text(s.value, 260, y, { lineBreak: false }); y += 14; }
  }
  if (r.footnote) doc.font("Italic").fontSize(8).fillColor(MUTED).text(r.footnote, 36, y + 10, { width: W });
  pageFooters(doc, `${r.school ?? "SmartSchool"} · ${r.title} · generated ${r.generatedAt ?? new Date().toISOString().slice(0, 16).replace("T", " ")}`);
  return collect(doc);
}

export async function renderReport(r: ReportData, format: "PDF" | "XLSX" | "CSV") {
  if (format === "CSV") return { data: toCsv(r), mime: "text/csv", ext: "csv" };
  if (format === "XLSX") return { data: await toXlsx(r), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" };
  return { data: await toPdf(r), mime: "application/pdf", ext: "pdf" };
}

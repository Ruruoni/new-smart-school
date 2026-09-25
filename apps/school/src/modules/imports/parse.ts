import ExcelJS from "exceljs";
import { AppError, validation } from "@/platform/errors";
import type { DetectedType } from "@/platform/files";

export const MAX_ROWS = 5000;
export const MAX_COLUMNS = 40;

export interface ParsedSheet {
  headers: string[];
  rows: { rowNumber: number; cells: Record<string, string> }[];
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s_\-./*]+/g, "");

/** Turn any Excel/CSV cell into a trimmed string. Dates become YYYY-MM-DD; rich text / formulas resolve to their value. */
export function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") {
    if ("result" in v && v.result !== undefined) return cellToString(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((r) => r.text).join("").trim();
    if ("text" in v) return String(v.text).trim();
    if ("hyperlink" in v) return String((v as { text?: string }).text ?? v.hyperlink).trim();
    if ("error" in v) return "";
  }
  return String(v).trim();
}

export async function parseXlsx(data: Buffer): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
  } catch {
    throw new AppError("BAD_SPREADSHEET", "That file is not a readable Excel workbook", 422);
  }
  const ws = wb.worksheets[0];
  if (!ws) throw validation("The workbook has no sheets");
  if (ws.rowCount > MAX_ROWS + 1) throw new AppError("TOO_MANY_ROWS", `A single import may contain at most ${MAX_ROWS} rows`, 422);
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, col) => { headers[col - 1] = cellToString(cell.value); });
  if (headers.length > MAX_COLUMNS) throw validation(`Too many columns (max ${MAX_COLUMNS})`);
  const rows: ParsedSheet["rows"] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const s = cellToString(row.getCell(i + 1).value);
      if (s !== "") any = true;
      cells[h] = s;
    });
    if (any) rows.push({ rowNumber, cells });
  });
  return { headers: headers.filter(Boolean), rows };
}

/** Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF, embedded newlines). */
export function parseCsv(text: string): ParsedSheet {
  const t = text.replace(/^﻿/, "");
  const table: string[][] = [];
  let row: string[] = [], cur = "", inQ = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (inQ) {
      if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; row.push(cur); cur = ""; table.push(row); row = []; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); table.push(row); }
  if (!table.length) throw validation("The file is empty");
  const headers = table[0]!.map((h) => h.trim());
  if (table.length - 1 > MAX_ROWS) throw new AppError("TOO_MANY_ROWS", `A single import may contain at most ${MAX_ROWS} rows`, 422);
  const rows: ParsedSheet["rows"] = [];
  table.slice(1).forEach((r, idx) => {
    const cells: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => { if (!h) return; const s = (r[i] ?? "").trim(); if (s) any = true; cells[h] = s; });
    if (any) rows.push({ rowNumber: idx + 2, cells });
  });
  return { headers: headers.filter(Boolean), rows };
}

export async function parseSheet(data: Buffer, type: DetectedType): Promise<ParsedSheet> {
  if (type === "xlsx") return parseXlsx(data);
  if (type === "csv") return parseCsv(data.toString("utf8"));
  throw validation("Upload an .xlsx or .csv file");
}

export interface ColumnDef {
  key: string;
  label: string;
  aliases?: string[];
  required?: boolean;
  example?: string;
  help?: string;
}

/** Map arbitrary user headers ("Date of Birth", "DOB", "date_of_birth") onto canonical column keys. */
export function mapHeaders(defs: readonly ColumnDef[], headers: readonly string[]): { map: Map<string, string>; missing: string[]; unknown: string[] } {
  const lookup = new Map<string, string>();
  for (const d of defs) for (const name of [d.key, d.label, ...(d.aliases ?? [])]) lookup.set(norm(name), d.key);
  const map = new Map<string, string>(); // original header → canonical key
  const unknown: string[] = [];
  for (const h of headers) {
    const key = lookup.get(norm(h));
    if (key && ![...map.values()].includes(key)) map.set(h, key);
    else unknown.push(h);
  }
  const have = new Set(map.values());
  return { map, missing: defs.filter((d) => d.required && !have.has(d.key)).map((d) => d.label), unknown };
}

export async function buildTemplate(defs: readonly ColumnDef[], sheetName: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(defs.map((d) => d.label + (d.required ? " *" : "")));
  ws.addRow(defs.map((d) => d.example ?? ""));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => { c.width = 22; });
  const notes = wb.addWorksheet("Instructions");
  notes.addRow(["Column", "Required", "Notes"]);
  for (const d of defs) notes.addRow([d.label, d.required ? "Yes" : "No", d.help ?? ""]);
  notes.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

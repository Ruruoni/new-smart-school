"use client";
import type { ReactNode } from "react";
import { cx } from "./kit";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  /** Extra classes for the cell (e.g. hide on small screens: "hidden md:table-cell"). */
  className?: string;
}

/** The register: ruled rows, sticky header, optional state margin per row (ok | warn | bad | info). */
export function DataTable<T>({ columns, rows, rowKey, rule, onRowClick, compact, caption }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; rule?: (r: T) => "ok" | "warn" | "bad" | "info" | undefined; onRowClick?: (r: T) => void; compact?: boolean; caption?: string }) {
  return (
    <div className="overflow-x-auto rounded-(--radius-panel) border border-line bg-surface">
      <table className={cx("register", compact && "compact")}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={cx(c.align === "right" && "right", c.align === "center" && "center", c.className)}>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} data-rule={rule?.(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={onRowClick ? "cursor-pointer" : undefined}>
              {columns.map((c) => <td key={c.key} className={cx(c.align === "right" && "right num", c.align === "center" && "center", c.className)}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import type { AuditRow } from "./store";

/** Entries on a page of the audit log. */
export const AUDIT_PAGE = 50;
/** The most entries one export holds, newest first. */
export const MAX_EXPORT = 10_000;

/**
 * A CSV cell that a spreadsheet reads as text: a value starting with =, +, -, @, a tab or a carriage return would be
 * taken for a formula, so it gets a quote mark in front. Every cell is quoted.
 */
export function csvCell(value: string | number | null): string {
  let s = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function auditCsv(rows: AuditRow[]): string {
  const lines = [["id", "created_at", "action", "login", "detail"].map(csvCell).join(",")];
  for (const r of rows) lines.push([r.id, r.created_at, r.action, r.login, r.detail].map(csvCell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** An action name as a filter takes it: what the log writes, letters and underscores. */
export const isAction = (s: unknown): s is string => typeof s === "string" && /^[a-z_]{1,40}$/.test(s);

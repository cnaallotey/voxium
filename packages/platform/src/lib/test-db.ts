/** Test helper. Not used by the app. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database, D1PreparedStatement } from "./d1";

export const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

// D1 is SQLite, so run the real migrations and queries. Vite cannot resolve node:sqlite, hence getBuiltinModule.
export type Sqlite = { exec(sql: string): void; prepare(sql: string): { all(...v: unknown[]): unknown[]; run(...v: unknown[]): unknown } };
export function database(files = fs.readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()): { db: D1Database; raw: Sqlite } {
  const { DatabaseSync } = (process as any).getBuiltinModule("node:sqlite");
  const raw: Sqlite = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of files) raw.exec(fs.readFileSync(path.join(migrations, f), "utf8"));
  const statement = (sql: string, values: unknown[] = []): D1PreparedStatement => ({
    bind: (...v) => statement(sql, v),
    first: async <T,>() => (raw.prepare(sql).all(...values)[0] as T) ?? null,
    all: async <T,>() => ({ results: raw.prepare(sql).all(...values) as T[], meta: {} }),
    run: async () => {
      raw.prepare(sql).run(...values);
      return { results: [], meta: {} };
    },
  });
  return { raw, db: { prepare: (sql) => statement(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) } };
}

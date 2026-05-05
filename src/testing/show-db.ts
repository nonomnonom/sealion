import { Database } from "bun:sqlite";

/**
 * Print every table in a Sealion-managed SQLite db — handy after a sim run
 * to inspect accounts, trades, orders, and the trace log.
 */
export function printDbContents(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all();
    for (const { name } of tables) {
      const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all();
      console.log(`\n== ${name} (${rows.length} rows) ==`);
      for (const row of rows) console.log(row);
    }
  } finally {
    db.close();
  }
}

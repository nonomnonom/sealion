import { Database } from "bun:sqlite";
import { safeStringify } from "../utils.ts";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS account (
  account_id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER UNIQUE NOT NULL,
  display_name TEXT,
  handle TEXT,
  cash REAL NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  avg_entry_price REAL NOT NULL DEFAULT 0,
  realized_pnl REAL NOT NULL DEFAULT 0,
  fees_paid REAL NOT NULL DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS "order" (
  order_id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  price REAL,
  size REAL NOT NULL,
  remaining REAL NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_order_agent ON "order" (agent_id);
CREATE INDEX IF NOT EXISTS idx_order_status ON "order" (status);

CREATE TABLE IF NOT EXISTS trade (
  trade_id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  buy_order_id INTEGER NOT NULL,
  sell_order_id INTEGER NOT NULL,
  buy_agent_id INTEGER NOT NULL,
  sell_agent_id INTEGER NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  taker_side TEXT NOT NULL,
  buyer_fee REAL NOT NULL DEFAULT 0,
  seller_fee REAL NOT NULL DEFAULT 0,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_trade_symbol_time ON trade (symbol, created_at);

CREATE TABLE IF NOT EXISTS tick (
  tick_id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  size REAL NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS trace (
  trace_id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER,
  action TEXT NOT NULL,
  info TEXT,
  result TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS interview (
  interview_id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS copy_trade_edge (
  edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  leader_id INTEGER NOT NULL,
  follower_id INTEGER NOT NULL,
  ratio REAL NOT NULL DEFAULT 1.0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT,
  UNIQUE(leader_id, follower_id)
);

CREATE INDEX IF NOT EXISTS idx_copy_leader ON copy_trade_edge (leader_id);
CREATE INDEX IF NOT EXISTS idx_copy_follower ON copy_trade_edge (follower_id);

CREATE TABLE IF NOT EXISTS signal (
  signal_id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  symbol TEXT,
  bias TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_signal_agent ON signal (agent_id);
`;

export interface AccountRow {
  account_id: number;
  agent_id: number;
  display_name: string | null;
  handle: string | null;
  cash: number;
  position: number;
  avg_entry_price: number;
  realized_pnl: number;
  fees_paid: number;
  created_at: string;
}

export interface OrderRow {
  order_id: number;
  agent_id: number;
  symbol: string;
  side: string;
  type: string;
  price: number | null;
  size: number;
  remaining: number;
  status: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TradeRow {
  trade_id: number;
  symbol: string;
  buy_order_id: number;
  sell_order_id: number;
  buy_agent_id: number;
  sell_agent_id: number;
  price: number;
  size: number;
  taker_side: string;
  buyer_fee: number;
  seller_fee: number;
  created_at: string;
}

export interface TickRow {
  tick_id: number;
  symbol: string;
  price: number;
  size: number;
  created_at: string;
}

export interface CopyTradeEdgeRow {
  edge_id: number;
  leader_id: number;
  follower_id: number;
  ratio: number;
  active: number;
  created_at: string;
}

export interface SignalRow {
  signal_id: number;
  agent_id: number;
  content: string;
  symbol: string | null;
  bias: string | null;
  created_at: string;
}

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function logTrace(
  db: Database,
  agentId: number | null,
  action: string,
  info: Record<string, unknown> | null,
  result: unknown = null,
): void {
  db.run(`INSERT INTO trace (agent_id, action, info, result, created_at) VALUES (?, ?, ?, ?, ?)`, [
    agentId,
    action,
    info ? safeStringify(info) : null,
    result === null || result === undefined ? null : safeStringify(result),
    nowIso(),
  ]);
}

// ─── Copy-trade edge helpers ────────────────────────────────────────────────

export function getCopyTradeEdges(db: Database, leaderId?: number): CopyTradeEdgeRow[] {
  if (leaderId !== undefined) {
    return db
      .query<CopyTradeEdgeRow, [number]>(
        `SELECT * FROM copy_trade_edge WHERE leader_id = ? AND active = 1`,
      )
      .all(leaderId);
  }
  return db.query<CopyTradeEdgeRow, []>(`SELECT * FROM copy_trade_edge WHERE active = 1`).all();
}

export function insertCopyTradeEdge(
  db: Database,
  leaderId: number,
  followerId: number,
  ratio = 1.0,
): void {
  db.run(
    `INSERT OR REPLACE INTO copy_trade_edge (leader_id, follower_id, ratio, active, created_at)
     VALUES (?, ?, ?, 1, ?)`,
    [leaderId, followerId, ratio, nowIso()],
  );
}

export function deactivateCopyTradeEdge(db: Database, followerId: number): void {
  db.run(`UPDATE copy_trade_edge SET active = 0 WHERE follower_id = ?`, [followerId]);
}

// ─── Signal helpers ────────────────────────────────────────────────────────

export function getSignals(db: Database, agentId?: number, limit = 50): SignalRow[] {
  if (agentId !== undefined) {
    return db
      .query<SignalRow, [number, number]>(
        `SELECT * FROM signal WHERE agent_id = ? ORDER BY signal_id DESC LIMIT ?`,
      )
      .all(agentId, limit);
  }
  return db
    .query<SignalRow, [number]>(`SELECT * FROM signal ORDER BY signal_id DESC LIMIT ?`)
    .all(limit);
}

export function insertSignal(
  db: Database,
  agentId: number,
  content: string,
  symbol?: string,
  bias?: string,
): void {
  db.run(
    `INSERT INTO signal (agent_id, content, symbol, bias, created_at) VALUES (?, ?, ?, ?, ?)`,
    [agentId, content, symbol ?? null, bias ?? null, nowIso()],
  );
}

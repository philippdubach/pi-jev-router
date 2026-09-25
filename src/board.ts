/**
 * Durable task board (M3). SQLite via node:sqlite (no native deps).
 * Authoritative state lives here; pi session entries hold only references.
 *
 * States: queued -> ready -> running -> verifying -> done | blocked | failed | cancelled
 * Transitions are compare-and-set; a worker can submit artifacts but only
 * the acceptance path marks a task done.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ROUTER_DIR } from "./paths.ts";

export const BOARD_DIR = ROUTER_DIR;
const DB_FILE = join(BOARD_DIR, "board.db");

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!db) {
    mkdirSync(BOARD_DIR, { recursive: true });
    db = new DatabaseSync(join(BOARD_DIR, "board.sqlite"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      role TEXT NOT NULL DEFAULT 'implementer',
      model TEXT,
      thinking TEXT,
      brief_path TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_nonce TEXT,
      result_summary TEXT,
      verification TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      kind TEXT NOT NULL,
      data TEXT
    );`);
  }
  return db;
}

export type TaskStatus =
  | "queued" | "ready" | "running" | "verifying" | "done"
  | "blocked" | "failed" | "cancelled";

export interface Task {
  id: string;
  objective: string;
  status: TaskStatus;
  model: string | null;
  thinking: string | null;
  briefPath: string | null;
  attempt: number;
  resultSummary: string | null;
  verification: string | null;
}

function rowToTask(r: any): Task {
  return {
    id: r.id, objective: r.objective, status: r.status, model: r.model,
    thinking: r.thinking, briefPath: r.brief_path, attempt: r.attempt,
    resultSummary: r.result_summary, verification: r.verification,
  } as any;
}

export function createTask(objective: string, role = "implementer"): Task {
  const db = getDb();
  const id = `task-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO tasks (id, objective, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, objective, role, now, now);
  logEvent(id, "created", { role });
  return getTask(id)!;
}

export function getTask(id: string): Task | undefined {
  const r = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
  return r ? rowToTask(r) : undefined;
}

export function listTasks(status?: TaskStatus): Task[] {
  const rows = status
    ? getDb().prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at").all(status)
    : getDb().prepare("SELECT * FROM tasks ORDER BY created_at").all();
  return rows.map(rowToTask);
}

/** Atomic CAS transition; returns false if the task was not in expectedStatus. */
export function transition(id: string, expected: TaskStatus | null, next: TaskStatus, extra?: Record<string, any>): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const sets = ["status = ?", "updated_at = ?"];
  const vals: any[] = [next, now];
  if (extra?.model !== undefined) { sets.push("model = ?"); vals.push(extra.model); }
  if (extra?.thinking !== undefined) { sets.push("thinking = ?"); vals.push(extra.thinking); }
  if (extra?.briefPath !== undefined) { sets.push("brief_path = ?"); vals.push(extra.briefPath); }
  if (extra?.leaseOwner !== undefined) { sets.push("lease_owner = ?"); vals.push(extra.leaseOwner); }
  if (extra?.leaseNonce !== undefined) { sets.push("lease_nonce = ?"); vals.push(extra.leaseNonce); }
  if (extra?.resultSummary !== undefined) { sets.push("result_summary = ?"); vals.push(extra.resultSummary); }
  if (extra?.verification !== undefined) { sets.push("verification = ?"); vals.push(extra.verification); }
  if (extra?.attempt !== undefined) { sets.push("attempt = ?"); vals.push(extra.attempt); }
  const where = expected === null ? "id = ?" : "id = ? AND status = ?";
  const params = next === null ? [...vals, id] : [...vals, id, ...(expected === null ? [] : [expected])];
  // build WHERE correctly: expected may be null meaning "any"
  const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?${expected !== null ? " AND status = ?" : ""}`;
  const res = db.prepare(sql).run(...(expected !== null ? [...vals, id, expected] : [...vals, id]));
  const ok = Number(res.changes) === 1;
  if (ok) logEvent(id, `status:${next}`, extra);
  return ok;
}

export function logEvent(taskId: string, kind: string, data?: unknown): void {
  getDb().prepare("INSERT INTO events (task_id, ts, kind, data) VALUES (?, ?, ?, ?)")
    .run(taskId, new Date().toISOString(), kind, data ? JSON.stringify(data) : null);
}

export function getEvents(taskId: string): any[] {
  return getDb().prepare("SELECT ts, kind, data FROM events WHERE task_id = ? ORDER BY id")
    .all(taskId) as any[];
}
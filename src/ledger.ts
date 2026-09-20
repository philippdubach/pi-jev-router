/**
 * Append-only JSONL decision ledger (M1).
 * SQLite board arrives with M3; this records shadow routing decisions only.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const LEDGER_DIR = join(homedir(), ".pi", "agent", "jev-router");
export const LEDGER_FILE = join(LEDGER_DIR, "decisions.jsonl");

export interface DecisionRecord {
  ts: string;
  taskId: string;
  mode: "shadow" | "auto" | "off";
  recommendation: unknown;
  classification?: unknown;
  note?: string;
  // Frontier observability, copied from the Recommendation for easy filtering.
  candidateCount?: number;
  frontierSize?: number;
  q?: number;
  cEst?: number;
  tEst?: number;
  lambda?: number;
  mu?: number;
  reason?: string;
}

export function record(entry: Omit<DecisionRecord, "ts">): void {
  mkdirSync(LEDGER_DIR, { recursive: true });
  appendFileSync(LEDGER_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}
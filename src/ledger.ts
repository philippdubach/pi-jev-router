/**
 * Append-only JSONL decision ledger (M1).
 * SQLite board arrives with M3; this records shadow routing decisions only.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ROUTER_DIR } from "./paths.ts";

export const LEDGER_DIR = ROUTER_DIR;
export const LEDGER_FILE = join(LEDGER_DIR, "decisions.jsonl");

export interface DecisionRecord {
  ts: string;
  taskId: string;
  mode: "shadow" | "auto" | "off";
  recommendation: unknown;
  classification?: unknown;
  note?: string;
  /**
   * Truncated prompt and context size. Without these, a bad classification
   * cannot be traced back to the input that caused it.
   */
  objective?: string;
  contextChars?: number;
  workKind?: string;
  /** True when a continuation prompt inherited the previous work kind. */
  inheritedWorkKind?: boolean;
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

/** Prompts can be long and can carry secrets; keep only a short head. */
export const OBJECTIVE_SNIPPET_CHARS = 160;

export function record(entry: Omit<DecisionRecord, "ts">): void {
  mkdirSync(LEDGER_DIR, { recursive: true });
  const safe = { ...entry };
  if (typeof safe.objective === "string") {
    safe.objective = safe.objective.replace(/\s+/g, " ").trim().slice(0, OBJECTIVE_SNIPPET_CHARS);
  }
  appendFileSync(LEDGER_FILE, JSON.stringify({ ts: new Date().toISOString(), ...safe }) + "\n");
}
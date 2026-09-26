/**
 * Append-only JSONL decision ledger (M1).
 * SQLite board arrives with M3; this records shadow routing decisions only.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ROUTER_DIR } from "./paths.ts";
import { LOADED_VERSION } from "./version.ts";
import type { DispatchOutcome } from "./dispatch.ts";

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
  /**
   * Head of the context block that reached the classifier. Diagnosing why a
   * prompt classified as unclear required replaying a session file by hand
   * because the ledger stored only the length.
   */
  contextHead?: string;
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
  /** Loaded package version (`src/version.ts`). */
  routerVersion?: string;
  /** The model that ran, when it differs from the pick (pin, abstain, shadow). */
  activeModel?: string;
  /** Session size in tokens when the decision was made. Replay needs it. */
  contextTokens?: number;
  /** Outcome of the dispatch: whether verification passed, failed, or worker errored. */
  dispatchOutcome?: DispatchOutcome;
}

/** Prompts can be long and can carry secrets; keep only a short head. */
export const OBJECTIVE_SNIPPET_CHARS = 160;
export const CONTEXT_HEAD_CHARS = 400;

/**
 * Append a decision record to the ledger. Silently fails to stderr on write error.
 * A ledger is diagnostics; a failed write must not break a routed task or a dispatch.
 */
export function record(entry: Omit<DecisionRecord, "ts">): void {
  try {
    mkdirSync(LEDGER_DIR, { recursive: true });
    const safe = { ...entry };
    if (typeof safe.objective === "string") {
      safe.objective = safe.objective.replace(/\s+/g, " ").trim().slice(0, OBJECTIVE_SNIPPET_CHARS);
    }
    if (typeof safe.contextHead === "string") {
      safe.contextHead = safe.contextHead.slice(0, CONTEXT_HEAD_CHARS);
    }
    appendFileSync(LEDGER_FILE, JSON.stringify({ ts: new Date().toISOString(), routerVersion: LOADED_VERSION, ...safe }) + "\n");
  } catch (err) {
    process.stderr.write(`jev-router: ledger write failed: ${String(err)}\n`);
  }
}
/**
 * Replay recorded routing decisions through the selector as it is now.
 *
 * Run: node --experimental-strip-types eval/replay.ts [ledger.jsonl] [--rows]
 * No model calls. Uses the cached catalog and the committed evidence.
 * A selection change is judged by the diff it makes here before it goes live.
 */
import { readFileSync } from "node:fs";
import { loadCatalog, type CatalogModel } from "../src/catalog.ts";
import { loadEvidence, type EvidenceIndex } from "../src/evidence.ts";
import { LEDGER_FILE } from "../src/ledger.ts";
import { selectModel, type WorkKind } from "../src/selector.ts";
import type { TaskEnvelope } from "../src/task-envelope.ts";

export const REPLAY_DEFAULT_TOKENS = 20000;
const KINDS = new Set(["planning", "code", "writing", "other"]);

export interface ReplayRow {
  ts: string;
  objective: string;
  workKind: WorkKind;
  complexity?: number;
  recorded?: string;
  pick: string;
  reason: string;
}

export function replayRows(rows: unknown[], catalog: CatalogModel[], evidence: EvidenceIndex): { replayed: ReplayRow[]; skipped: number } {
  const replayed: ReplayRow[] = [];
  let skipped = 0;
  for (const raw of rows) {
    const r = raw as any;
    const cls = r?.classification;
    if (!r || typeof r !== "object" || !cls?.ok || !cls.answers) { skipped++; continue; }
    const objective = typeof r.objective === "string" ? r.objective : "";
    const workKind: WorkKind = KINDS.has(r.workKind) ? r.workKind : "other";
    const env: TaskEnvelope = {
      taskId: String(r.taskId ?? "replay"), role: "direct", objective, acceptanceCriteria: [],
      relevantContext: String(r.contextHead ?? ""),
      facts: { hasImages: false, estimatedContextTokens: Number(r.contextTokens) || REPLAY_DEFAULT_TOKENS, requiredTools: [], attempt: 0, priorFailureKinds: [] },
      policyRef: "replay",
    };
    const rec = selectModel(env, cls, catalog, evidence, workKind);
    const cx = cls.answers.complexity?.value;
    replayed.push({
      ts: String(r.ts ?? ""), objective: objective.slice(0, 60), workKind,
      complexity: typeof cx === "number" ? cx : undefined,
      recorded: r.recommendation?.modelId, pick: rec.modelId, reason: rec.reason,
    });
  }
  return { replayed, skipped };
}

export function summarise(rows: ReplayRow[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const byPick = (out[r.workKind] ??= {});
    const key = `${r.pick || "(abstain)"} [${r.reason}]`;
    byPick[key] = (byPick[key] ?? 0) + 1;
  }
  return out;
}

if (import.meta.main) {
  const path = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? LEDGER_FILE;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const { models } = await loadCatalog();
  const { replayed, skipped } = replayRows(rows, models, loadEvidence());
  console.log(`replayed ${replayed.length}, skipped ${skipped}, catalog ${models.length}`);
  for (const [kind, picks] of Object.entries(summarise(replayed))) {
    console.log(`\n${kind}`);
    for (const [k, n] of Object.entries(picks).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  if (process.argv.includes("--rows")) {
    for (const r of replayed) console.log(`${r.ts.slice(0, 16)} ${r.workKind.padEnd(8)} cx=${r.complexity?.toFixed(2) ?? "-"} ${r.pick} (${r.reason}) ← ${r.objective}`);
  }
}

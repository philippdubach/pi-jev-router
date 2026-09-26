/**
 * Work-kind accuracy of classifier + resolveWorkKind on labelled prompts.
 *
 * --extract   write unique, non-continuation ledger prompts to
 *             eval/classifier-set.candidates.jsonl for hand labelling
 * (default)   classify eval/classifier-set.jsonl live (~$0.00004 each)
 *             and print accuracy and a confusion matrix
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../src/classifier.ts";
import { isContinuation } from "../src/continuity.ts";
import { LEDGER_FILE } from "../src/ledger.ts";
import { resolveWorkKind } from "../src/selector.ts";
import type { TaskEnvelope } from "../src/task-envelope.ts";

const DIR = import.meta.dirname;

if (process.argv.includes("--extract")) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of readFileSync(LEDGER_FILE, "utf8").split("\n").filter(Boolean)) {
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    const p = String(r.objective ?? "").trim();
    if (!p || isContinuation(p) || seen.has(p) || p === "probe") continue;
    seen.add(p);
    out.push(JSON.stringify({ prompt: p, context: r.contextHead ?? "", expected: "" }));
  }
  writeFileSync(join(DIR, "classifier-set.candidates.jsonl"), out.join("\n") + "\n");
  console.log(`${out.length} candidates written; label "expected" as planning|code|writing|other`);
} else {
  const items = readFileSync(join(DIR, "classifier-set.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const confusion: Record<string, Record<string, number>> = {};
  let right = 0;
  for (const it of items) {
    const env: TaskEnvelope = {
      taskId: "eval", role: "direct", objective: it.prompt, acceptanceCriteria: [], relevantContext: it.context,
      facts: { hasImages: false, estimatedContextTokens: 2000, requiredTools: [], attempt: 0, priorFailureKinds: [] }, policyRef: "eval",
    };
    const c = await classify(env);
    const got = resolveWorkKind(undefined, String((c.answers as any)?.category?.value ?? ""), it.prompt);
    const row = (confusion[it.expected] ??= {});
    row[got] = (row[got] ?? 0) + 1;
    if (got === it.expected) right++;
    else console.log(`MISS ${it.expected} -> ${got}: ${it.prompt.slice(0, 70)}`);
  }
  console.log(`\naccuracy ${right}/${items.length}`);
  console.log(JSON.stringify(confusion, null, 2));
}

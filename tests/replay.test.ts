// Replay — run: node --experimental-strip-types tests/replay.test.ts
import { replayRows, summarise } from "../eval/replay.ts";
import type { CatalogModel } from "../src/catalog.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed++;
};
const model = (id: string, price: number, intelligence: number): CatalogModel => ({
  id, contextLength: 1_000_000, promptPrice: price, completionPrice: price * 5,
  supportsTools: true, supportsReasoning: true, inputModalities: ["text"], expiresAt: null,
  aa: { intelligence, coding: intelligence, agentic: intelligence },
});
const catalog = [model("a/cheap", 1e-7, 30), model("b/mid", 1e-6, 45), model("c/top", 1e-5, 58)];
const cls = (cx: number, cat: string = "implementation") => ({ ok: true, requestedModel: "j", resolvedModel: "j", latencyMs: 1, answers: {
  category: { id: "category", type: "choice", value: cat },
  complexity: { id: "complexity", type: "score", value: cx },
  risk: { id: "risk", type: "score", value: 0.5 },
} });
const rows = [
  { ts: "2026-09-26T00:00:00Z", objective: "implement x", workKind: "code", classification: cls(1), recommendation: { modelId: "a/cheap" } },
  { ts: "2026-09-26T00:01:00Z", objective: "probe" },                           // no classification
  { ts: "2026-09-26T00:02:00Z", objective: "plan y", classification: cls(2) },  // no workKind, category "implementation" -> derived as "code"
  { ts: "2026-09-26T00:03:00Z", workKind: "planning", classification: cls(1) }, // no objective
  { ts: "2026-09-26T00:04:00Z", classification: cls(1, "unclear") },            // no workKind, category "unclear" -> derived as "other"
  "not an object",
];
const { replayed, skipped } = replayRows(rows, catalog, {});
check("classified rows are replayed", replayed.length === 4, String(replayed.length));
check("unclassified and malformed rows are counted, not thrown", skipped === 2, String(skipped));
check("missing workKind is derived from the category", replayed[1].workKind === "code");
check("missing objective replays with empty string", replayed[2].workKind === "planning" && replayed[2].objective === "");
check("unclear category derives to other", replayed[3].workKind === "other");
check("recorded pick is carried", replayed[0].recorded === "a/cheap");
const s = summarise(replayed);
check("summary counts per kind", Object.values(s.code ?? {}).reduce((a, b) => a + b, 0) === 2);
process.exit(failed ? 1 : 0);

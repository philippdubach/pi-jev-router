# Dynamic Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded model tables in `src/selector.ts` with a selector that ranks the full OpenRouter catalog per task using a Pareto frontier over quality, cost, and latency.

**Architecture:** `src/catalog.ts` fetches and caches the OpenRouter catalog. `src/evidence.ts` aggregates recorded eval runs. `src/frontier.ts` computes dominance and the tangency point. `src/selector.ts` stays pure and receives catalog and evidence as arguments. Quality, cost, and latency each blend recorded evidence with a prior using the same shrinkage weight.

**Tech Stack:** TypeScript run directly by Node with `--experimental-strip-types`. No test framework. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-20-dynamic-model-selection-design.md`

## Global Constraints

- Node runs TypeScript directly: `node --experimental-strip-types <file>`. Do not add a build step.
- Do not add dependencies. The only runtime dependency stays `@typesafe-ai/sdk`.
- Tests are plain scripts. They print `PASS` or `FAIL` per case and call `process.exit(failed ? 1 : 0)`. Do not introduce a test framework.
- `src/selector.ts` is pure. No network call. No file read. It may read the clock
  only through an injectable `now` option so tests stay deterministic.
- `src/evidence.ts` must import `WorkKind` from `src/selector.ts` with `import type`,
  never a value import. `src/selector.ts` imports `statsFor` from `src/evidence.ts`
  as a value. The `import type` is erased at runtime, so the cycle never forms.
  Changing it to a value import creates a runtime circular import.
- Write STE in comments and docs. Short sentences. One idea per sentence. Active voice.
- No AI filler in prose: no "delve", "testament", "furthermore", "moreover", "in conclusion", no "not X but Y".
- No AI attribution in commit messages. No `Co-Authored-By` trailer.
- One task per commit.
- Before each commit these must pass:
  ```bash
  node --experimental-strip-types tests/selector.test.ts
  node --experimental-strip-types tests/role-routing.test.ts
  node --experimental-strip-types tests/worktree.test.ts
  ```
- Shrinkage constant `K = 5`. Proven-gate threshold `PROVEN_RUNS = 3`. Context headroom `1.3`.
- Jev is called at most once per task. Do not add a second classification call.

## Known evidence state

All nine files in `eval/results/` together yield only three proven pairs at `runs >= 3`:

| Model | Work kind | Runs |
|---|---|---|
| `anthropic/claude-sonnet-5` | code | 7 |
| `openrouter/pareto-code` | code | 7 |
| `anthropic/claude-sonnet-5` | planning | 6 |

`writing` has no proven model. A writing task with `risk >= 2` therefore triggers
relaxation step 1 on day one. This is expected. Do not tune the threshold to hide it.

---

### Task 1: Catalog module

**Files:**
- Create: `src/catalog.ts`
- Create: `tests/catalog.test.ts`
- Create: `tests/fixtures/catalog-sample.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `CatalogModel`, `AaIndices`, `normalizeCatalog(raw: unknown): CatalogModel[]`, `loadCatalog(opts?: { now?: number; fetchImpl?: typeof fetch }): Promise<{ models: CatalogModel[]; stale: boolean; source: "network" | "cache" | "bootstrap" }>`, `BOOTSTRAP_MODELS: CatalogModel[]`, `CATALOG_URL`, `CATALOG_TTL_MS`.

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/catalog-sample.json`. These are verified records from the live catalog on 2026-09-20, plus one malformed entry.

```json
{
  "data": [
    {
      "id": "anthropic/claude-sonnet-5",
      "context_length": 1000000,
      "pricing": { "prompt": "0.000002", "completion": "0.00001" },
      "supported_parameters": ["tools", "reasoning", "max_tokens"],
      "architecture": { "input_modalities": ["text", "image", "file"] },
      "benchmarks": { "artificial_analysis": { "intelligence_index": 38.2, "coding_index": 71.5, "agentic_index": 43.6 } }
    },
    {
      "id": "google/gemini-3.8-flash",
      "context_length": 1048576,
      "pricing": { "prompt": "0.00000075", "completion": "0.00000375" },
      "supported_parameters": ["tools", "reasoning"],
      "architecture": { "input_modalities": ["text", "image", "video", "file", "audio"] },
      "benchmarks": { "artificial_analysis": { "intelligence_index": 40.9, "coding_index": 76.3, "agentic_index": 40.2 } }
    },
    {
      "id": "some/no-tools-model",
      "context_length": 8192,
      "pricing": { "prompt": "0.0000001", "completion": "0.0000002" },
      "supported_parameters": ["max_tokens"],
      "architecture": { "input_modalities": ["text"] }
    },
    {
      "id": "some/expired-model",
      "context_length": 32768,
      "pricing": { "prompt": "0.000001", "completion": "0.000002" },
      "supported_parameters": ["tools"],
      "architecture": { "input_modalities": ["text"] },
      "expiration_date": "2020-01-01T00:00:00Z"
    },
    { "id": 42, "context_length": "not a number" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/catalog.test.ts`:

```ts
// Catalog parsing — run: node --experimental-strip-types tests/catalog.test.ts
import { readFileSync } from "node:fs";
import { normalizeCatalog, loadCatalog, BOOTSTRAP_MODELS, CATALOG_TTL_MS } from "../src/catalog.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) failed++;
};

const raw = JSON.parse(readFileSync(new URL("./fixtures/catalog-sample.json", import.meta.url), "utf8"));
const models = normalizeCatalog(raw);

check("drops malformed records", models.length === 4);

const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-5")!;
check("parses context length", sonnet.contextLength === 1000000);
check("parses prompt price", sonnet.promptPrice === 0.000002);
check("parses completion price", sonnet.completionPrice === 0.00001);
check("detects tool support", sonnet.supportsTools === true);
check("detects reasoning support", sonnet.supportsReasoning === true);
check("parses modalities", sonnet.inputModalities.includes("image"));
check("parses aa coding index", sonnet.aa?.coding === 71.5);
check("null expiry when absent", sonnet.expiresAt === null);

const noTools = models.find((m) => m.id === "some/no-tools-model")!;
check("records missing tool support", noTools.supportsTools === false);
check("null aa when absent", noTools.aa === null);

const expired = models.find((m) => m.id === "some/expired-model")!;
check("parses expiry to epoch ms", expired.expiresAt === Date.parse("2020-01-01T00:00:00Z"));

check("empty input yields empty list", normalizeCatalog({}).length === 0);
check("null input yields empty list", normalizeCatalog(null).length === 0);

check("bootstrap has three models", BOOTSTRAP_MODELS.length === 3);
check("bootstrap models priced", BOOTSTRAP_MODELS.every((m) => m.promptPrice > 0));

const failingFetch = async () => { throw new Error("network down"); };
const boot = await loadCatalog({ fetchImpl: failingFetch as any, cachePath: "/nonexistent/path.json" });
check("falls back to bootstrap", boot.source === "bootstrap" && boot.models.length === 3);

check("ttl is twelve hours", CATALOG_TTL_MS === 12 * 60 * 60 * 1000);

process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/catalog.test.ts`
Expected: FAIL, `Cannot find module '../src/catalog.ts'`.

- [ ] **Step 4: Implement the module**

Create `src/catalog.ts`:

```ts
/**
 * OpenRouter catalog: fetch, cache, normalise.
 *
 * This module owns every network call and every file read for model data.
 * `src/selector.ts` stays pure and receives the result as an argument.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_CACHE_PATH = join(homedir(), ".pi", "agent", "cache", "openrouter-models.json");

export interface AaIndices {
  intelligence: number;
  coding: number;
  agentic: number;
}

export interface CatalogModel {
  id: string;
  contextLength: number;
  /** USD per input token */
  promptPrice: number;
  /** USD per output token */
  completionPrice: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  inputModalities: string[];
  /** epoch ms, or null when the model does not expire */
  expiresAt: number | null;
  aa: AaIndices | null;
}

/** Verified from the live catalog on 2026-09-20. Used only when the catalog is unreachable. */
export const BOOTSTRAP_MODELS: CatalogModel[] = [
  {
    id: "google/gemini-3.8-flash",
    contextLength: 1048576,
    promptPrice: 0.00000075,
    completionPrice: 0.00000375,
    supportsTools: true,
    supportsReasoning: true,
    inputModalities: ["text", "image", "video", "file", "audio"],
    expiresAt: null,
    aa: { intelligence: 40.9, coding: 76.3, agentic: 40.2 },
  },
  {
    id: "anthropic/claude-sonnet-5",
    contextLength: 1000000,
    promptPrice: 0.000002,
    completionPrice: 0.00001,
    supportsTools: true,
    supportsReasoning: true,
    inputModalities: ["text", "image", "file"],
    expiresAt: null,
    aa: { intelligence: 38.2, coding: 71.5, agentic: 43.6 },
  },
  {
    id: "anthropic/claude-fable-5.1",
    contextLength: 1000000,
    promptPrice: 0.00001,
    completionPrice: 0.00005,
    supportsTools: true,
    supportsReasoning: true,
    inputModalities: ["text", "image", "file"],
    expiresAt: null,
    aa: { intelligence: 53.4, coding: 81.6, agentic: 57.9 },
  },
];

export function normalizeCatalog(raw: unknown): CatalogModel[] {
  const data = (raw as any)?.data;
  if (!Array.isArray(data)) return [];
  const out: CatalogModel[] = [];
  for (const m of data) {
    if (!m || typeof m.id !== "string") continue;
    const ctx = Number(m.context_length);
    if (!Number.isFinite(ctx) || ctx <= 0) continue;
    const params: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const modalities: string[] = Array.isArray(m.architecture?.input_modalities)
      ? m.architecture.input_modalities
      : [];
    const aaRaw = m.benchmarks?.artificial_analysis;
    const expiry = typeof m.expiration_date === "string" ? Date.parse(m.expiration_date) : NaN;
    out.push({
      id: m.id,
      contextLength: ctx,
      promptPrice: Number(m.pricing?.prompt) || 0,
      completionPrice: Number(m.pricing?.completion) || 0,
      supportsTools: params.includes("tools"),
      supportsReasoning: params.includes("reasoning"),
      inputModalities: modalities,
      expiresAt: Number.isFinite(expiry) ? expiry : null,
      aa:
        aaRaw && typeof aaRaw === "object"
          ? {
              intelligence: Number(aaRaw.intelligence_index) || 0,
              coding: Number(aaRaw.coding_index) || 0,
              agentic: Number(aaRaw.agentic_index) || 0,
            }
          : null,
    });
  }
  return out;
}

export interface LoadCatalogOptions {
  now?: number;
  fetchImpl?: typeof fetch;
  cachePath?: string;
}

export interface LoadCatalogResult {
  models: CatalogModel[];
  stale: boolean;
  source: "network" | "cache" | "bootstrap";
}

function readCache(path: string): { fetchedAt: number; models: CatalogModel[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed?.models) || typeof parsed?.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(path: string, models: CatalogModel[], now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: now, models }), "utf8");
  } catch {
    // A cache write failure must not break routing.
  }
}

export async function loadCatalog(opts: LoadCatalogOptions = {}): Promise<LoadCatalogResult> {
  const now = opts.now ?? Date.now();
  const cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
  const doFetch = opts.fetchImpl ?? fetch;

  const cached = readCache(cachePath);
  if (cached && now - cached.fetchedAt < CATALOG_TTL_MS) {
    return { models: cached.models, stale: false, source: "cache" };
  }

  try {
    const res = await doFetch(CATALOG_URL);
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const models = normalizeCatalog(await res.json());
    if (models.length === 0) throw new Error("catalog empty after normalisation");
    writeCache(cachePath, models, now);
    return { models, stale: false, source: "network" };
  } catch {
    if (cached) return { models: cached.models, stale: true, source: "cache" };
    return { models: BOOTSTRAP_MODELS, stale: true, source: "bootstrap" };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --experimental-strip-types tests/catalog.test.ts`
Expected: every line `PASS`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/catalog.ts tests/catalog.test.ts tests/fixtures/catalog-sample.json
git commit -m "Add OpenRouter catalog fetch, cache and normaliser"
```

---

### Task 2: Evidence module

**Files:**
- Create: `src/evidence.ts`
- Create: `tests/evidence.test.ts`

**Interfaces:**
- Consumes: `WorkKind` from `src/selector.ts`.
- Produces: `ModelStats`, `EvidenceIndex`, `workKindFromTaskId(taskId: string): WorkKind`, `buildEvidence(rows: EvalRow[]): EvidenceIndex`, `loadEvidence(dir?: string): EvidenceIndex`, `statsFor(evidence: EvidenceIndex, modelId: string, kind: WorkKind): ModelStats | undefined`.

- [ ] **Step 1: Write the failing test**

Create `tests/evidence.test.ts`:

```ts
// Evidence aggregation — run: node --experimental-strip-types tests/evidence.test.ts
import { buildEvidence, workKindFromTaskId, statsFor, type EvalRow } from "../src/evidence.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) failed++;
};

check("code prefix", workKindFromTaskId("code_lru_ttl") === "code");
check("plan prefix", workKindFromTaskId("plan_distributed_ratelimiter") === "planning");
check("write prefix", workKindFromTaskId("write_incident_postmortem") === "writing");
check("unknown prefix", workKindFromTaskId("weird_task") === "other");

const rows: EvalRow[] = [
  { taskId: "code_lru_ttl", modelUsed: "m/a", passed: true, costUsd: 0.10, latencyMs: 1000 },
  { taskId: "code_semver_sort", modelUsed: "m/a", passed: true, costUsd: 0.20, latencyMs: 3000 },
  { taskId: "code_retry_queue", modelUsed: "m/a", passed: false, costUsd: 0.30, latencyMs: 2000 },
  { taskId: "plan_x", modelUsed: "m/a", passed: true, costUsd: 1.00, latencyMs: 9000 },
  { taskId: "code_lru_ttl", modelUsed: "m/b", passed: true, costUsd: 0.05, latencyMs: 500 },
];

const ev = buildEvidence(rows);
const a = statsFor(ev, "m/a", "code")!;
check("counts runs", a.runs === 3);
check("counts passes", a.passes === 2);
check("means cost", Math.abs(a.meanCostUsd - 0.2) < 1e-9);
check("means latency", a.meanLatencyMs === 2000);

const aPlan = statsFor(ev, "m/a", "planning")!;
check("separates work kinds", aPlan.runs === 1 && aPlan.meanCostUsd === 1.0);

check("unknown model", statsFor(ev, "m/zzz", "code") === undefined);
check("unknown kind for known model", statsFor(ev, "m/b", "writing") === undefined);

const bad = buildEvidence([
  { taskId: "code_x", modelUsed: "", passed: true, costUsd: 1, latencyMs: 1 },
  { taskId: "code_y", modelUsed: "m/c", passed: true, costUsd: Number.NaN, latencyMs: 1 },
] as EvalRow[]);
check("drops rows with no model", statsFor(bad, "", "code") === undefined);
check("drops rows with non-finite cost", statsFor(bad, "m/c", "code") === undefined);

process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/evidence.test.ts`
Expected: FAIL, `Cannot find module '../src/evidence.ts'`.

- [ ] **Step 3: Implement the module**

Create `src/evidence.ts`:

```ts
/**
 * Aggregate recorded benchmark runs into per-model, per-work-kind statistics.
 *
 * This module reads files. `src/selector.ts` receives the result as an argument.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkKind } from "./selector.ts";

export interface EvalRow {
  taskId: string;
  modelUsed: string;
  passed: boolean;
  costUsd: number;
  latencyMs: number;
}

export interface ModelStats {
  runs: number;
  passes: number;
  meanCostUsd: number;
  meanLatencyMs: number;
}

export type EvidenceIndex = Record<string, Partial<Record<WorkKind, ModelStats>>>;

/** Benchmark task ids are prefixed by work kind. */
export function workKindFromTaskId(taskId: string): WorkKind {
  const prefix = taskId.split("_")[0];
  if (prefix === "code") return "code";
  if (prefix === "plan") return "planning";
  if (prefix === "write") return "writing";
  return "other";
}

export function buildEvidence(rows: EvalRow[]): EvidenceIndex {
  const acc: Record<string, Partial<Record<WorkKind, { runs: number; passes: number; cost: number; latency: number }>>> = {};
  for (const row of rows) {
    if (!row || typeof row.modelUsed !== "string" || row.modelUsed.length === 0) continue;
    if (!Number.isFinite(row.costUsd) || !Number.isFinite(row.latencyMs)) continue;
    const kind = workKindFromTaskId(row.taskId ?? "");
    const byModel = (acc[row.modelUsed] ??= {});
    const cell = (byModel[kind] ??= { runs: 0, passes: 0, cost: 0, latency: 0 });
    cell.runs += 1;
    if (row.passed) cell.passes += 1;
    cell.cost += row.costUsd;
    cell.latency += row.latencyMs;
  }
  const out: EvidenceIndex = {};
  for (const [modelId, kinds] of Object.entries(acc)) {
    out[modelId] = {};
    for (const [kind, cell] of Object.entries(kinds) as [WorkKind, any][]) {
      out[modelId][kind] = {
        runs: cell.runs,
        passes: cell.passes,
        meanCostUsd: cell.cost / cell.runs,
        meanLatencyMs: cell.latency / cell.runs,
      };
    }
  }
  return out;
}

export function statsFor(
  evidence: EvidenceIndex,
  modelId: string,
  kind: WorkKind,
): ModelStats | undefined {
  return evidence[modelId]?.[kind];
}

/** Read every benchmark result file in `dir` and aggregate them. */
export function loadEvidence(dir = join(import.meta.dirname, "..", "eval", "results")): EvidenceIndex {
  const rows: EvalRow[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return {};
  }
  for (const name of names) {
    if (!name.startsWith("benchmark-") || !name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
      for (const r of parsed?.results ?? []) {
        rows.push({
          taskId: String(r.taskId ?? ""),
          modelUsed: String(r.modelUsed ?? ""),
          passed: Boolean(r.passed),
          costUsd: Number(r.costUsd),
          latencyMs: Number(r.latencyMs),
        });
      }
    } catch {
      // A damaged result file must not break routing.
    }
  }
  return buildEvidence(rows);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types tests/evidence.test.ts`
Expected: every line `PASS`, exit 0.

- [ ] **Step 5: Verify against the real result files**

Run:
```bash
node --experimental-strip-types -e "
import { loadEvidence, statsFor } from './src/evidence.ts';
const ev = loadEvidence();
console.log('sonnet code runs', statsFor(ev,'anthropic/claude-sonnet-5','code')?.runs);
console.log('pareto code runs', statsFor(ev,'openrouter/pareto-code','code')?.runs);
console.log('sonnet planning runs', statsFor(ev,'anthropic/claude-sonnet-5','planning')?.runs);
"
```
Expected: `7`, `7`, `6`. These match the known evidence state above.

- [ ] **Step 6: Commit**

```bash
git add src/evidence.ts tests/evidence.test.ts
git commit -m "Aggregate benchmark results into per-model routing evidence"
```

---

### Task 3: Frontier module

**Files:**
- Create: `src/frontier.ts`
- Create: `tests/frontier.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Scored`, `dominates(a: Scored, b: Scored): boolean`, `nondominated(items: Scored[]): Scored[]`, `tangency(frontier: Scored[], lambda: number, mu: number): { pick: Scored; utility: number } | undefined`.

- [ ] **Step 1: Write the failing test**

Create `tests/frontier.test.ts`:

```ts
// Pareto frontier — run: node --experimental-strip-types tests/frontier.test.ts
import { dominates, nondominated, tangency, type Scored } from "../src/frontier.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) failed++;
};

const s = (id: string, q: number, c: number, t: number): Scored => ({ id, q, c, t });

check("strictly better dominates", dominates(s("a", 0.9, 1, 1), s("b", 0.5, 1, 1)));
check("cheaper dominates", dominates(s("a", 0.5, 1, 1), s("b", 0.5, 2, 1)));
check("faster dominates", dominates(s("a", 0.5, 1, 1), s("b", 0.5, 1, 2)));
check("identical does not dominate", !dominates(s("a", 0.5, 1, 1), s("b", 0.5, 1, 1)));
check("mixed does not dominate", !dominates(s("a", 0.9, 5, 1), s("b", 0.5, 1, 1)));

const mixed = [
  s("cheap-weak", 0.30, 0.01, 10),
  s("mid", 0.60, 0.10, 20),
  s("strong-costly", 0.95, 1.00, 30),
  s("dominated", 0.50, 0.50, 40),
];
const f = nondominated(mixed).map((x) => x.id).sort();
check("keeps the three non-dominated", f.join(",") === "cheap-weak,mid,strong-costly");
check("drops the dominated one", !f.includes("dominated"));

check("empty input", nondominated([]).length === 0);
check("single item is its own frontier", nondominated([s("solo", 0.5, 1, 1)]).length === 1);

const allEqual = [s("a", 0.5, 1, 1), s("b", 0.5, 1, 1)];
check("ties are all non-dominated", nondominated(allEqual).length === 2);

const one = [s("only", 0.42, 3, 7)];
check("one dominator collapses the set", nondominated([...one, s("worse", 0.1, 9, 9)]).length === 1);

// High lambda punishes cost, so the cheapest wins.
const frontier = nondominated(mixed);
check("high lambda picks cheap", tangency(frontier, 5.0, 0)!.pick.id === "cheap-weak");
// Zero lambda ignores cost, so the strongest wins.
check("zero lambda picks strong", tangency(frontier, 0, 0)!.pick.id === "strong-costly");
check("empty frontier returns undefined", tangency([], 1, 1) === undefined);

// Normalisation must be over the frontier, so a constant axis contributes nothing.
const flatCost = [s("a", 0.2, 1, 1), s("b", 0.8, 1, 1)];
check("constant axis is inert", tangency(flatCost, 9, 9)!.pick.id === "b");

process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/frontier.test.ts`
Expected: FAIL, `Cannot find module '../src/frontier.ts'`.

- [ ] **Step 3: Implement the module**

Create `src/frontier.ts`:

```ts
/**
 * Discrete Pareto frontier over quality, cost and latency.
 *
 * Quality rises. Cost and latency fall. Pure functions only.
 */

export interface Scored {
  id: string;
  /** quality in 0..1, higher is better */
  q: number;
  /** expected cost in USD, lower is better */
  c: number;
  /** expected latency in ms, lower is better */
  t: number;
}

/** `a` dominates `b` when `a` is no worse on every axis and better on one. */
export function dominates(a: Scored, b: Scored): boolean {
  const noWorse = a.q >= b.q && a.c <= b.c && a.t <= b.t;
  const better = a.q > b.q || a.c < b.c || a.t < b.t;
  return noWorse && better;
}

export function nondominated(items: Scored[]): Scored[] {
  return items.filter((candidate) => !items.some((other) => dominates(other, candidate)));
}

function minMax(values: number[]): (v: number) => number {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  // A constant axis carries no information, so it normalises to zero.
  if (!Number.isFinite(span) || span === 0) return () => 0;
  return (v: number) => (v - lo) / span;
}

/**
 * Pick the point on the frontier that maximises q - lambda*c - mu*t.
 * Each axis is normalised across the frontier, not across the catalog.
 */
export function tangency(
  frontier: Scored[],
  lambda: number,
  mu: number,
): { pick: Scored; utility: number } | undefined {
  if (frontier.length === 0) return undefined;
  const nq = minMax(frontier.map((m) => m.q));
  const nc = minMax(frontier.map((m) => m.c));
  const nt = minMax(frontier.map((m) => m.t));
  let best = frontier[0];
  let bestU = -Infinity;
  for (const m of frontier) {
    const u = nq(m.q) - lambda * nc(m.c) - mu * nt(m.t);
    if (u > bestU) {
      bestU = u;
      best = m;
    }
  }
  return { pick: best, utility: bestU };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types tests/frontier.test.ts`
Expected: every line `PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/frontier.ts tests/frontier.test.ts
git commit -m "Add Pareto dominance, frontier and tangency selection"
```

---

### Task 4: Estimators and selectModel

**Files:**
- Modify: `src/selector.ts` (replace lines 1-165, keep `resolveWorkKind` and `ROLE_THINKING`)
- Modify: `tests/selector.test.ts` (full rewrite)
- Modify: `tests/role-routing.test.ts:18-31` (profile assertions)

**Interfaces:**
- Consumes: `CatalogModel` from `src/catalog.ts`, `EvidenceIndex` and `statsFor` from `src/evidence.ts`, `Scored`, `nondominated`, `tangency` from `src/frontier.ts`, `TaskEnvelope` and `ClassificationResult` from `src/task-envelope.ts`.
- Produces: `WorkKind`, `RouterProfile`, `Weights`, `PROFILE_WEIGHTS`, `PINNED_MODELS`, `Recommendation`, `qualityPrior`, `feasible`, `selectModel`, `resolveWorkKind`, `ROLE_THINKING`, `K`, `PROVEN_RUNS`, `CONTEXT_HEADROOM`.

**Removed in this task:** `PROFILE_MODELS`, `ROLE_MODELS`, `recommend`, `recommendByRole`, `DEFAULT_POLICY`, `Policy`. Task 5 repairs the call sites, so the tree does not typecheck between Task 4 and Task 5. Commit both before running `npm test`.

- [ ] **Step 1: Write the failing test**

Replace `tests/selector.test.ts` entirely:

```ts
// Selector — run: node --experimental-strip-types tests/selector.test.ts
import { selectModel, feasible, PROFILE_WEIGHTS, PROVEN_RUNS } from "../src/selector.ts";
import type { CatalogModel } from "../src/catalog.ts";
import type { EvidenceIndex } from "../src/evidence.ts";
import type { TaskEnvelope } from "../src/task-envelope.ts";

let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(ok ? "PASS" : "FAIL", name);
  if (!ok) failed++;
};

const model = (id: string, over: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  contextLength: 1000000,
  promptPrice: 0.000002,
  completionPrice: 0.00001,
  supportsTools: true,
  supportsReasoning: true,
  inputModalities: ["text", "image"],
  expiresAt: null,
  aa: { intelligence: 38.2, coding: 71.5, agentic: 43.6 },
  ...over,
});

const env = (over: Partial<TaskEnvelope["facts"]> = {}): TaskEnvelope => ({
  taskId: "t-1",
  role: "implementer",
  objective: "Implement an LRU cache",
  acceptanceCriteria: [],
  relevantContext: "",
  facts: { hasImages: false, estimatedContextTokens: 1000, requiredTools: [], attempt: 0, priorFailureKinds: [], ...over },
  policyRef: "policy@v2",
});

const answers = (complexity: number, risk: number) => ({
  ok: true, requestedModel: "j", resolvedModel: "j", latencyMs: 1,
  answers: {
    category: { id: "category", type: "choice" as const, value: "implementation" },
    complexity: { id: "complexity", type: "score" as const, value: complexity },
    risk: { id: "risk", type: "score" as const, value: risk },
  },
});

// --- feasibility ---
check("rejects no tool support", !feasible(model("x", { supportsTools: false }), env(), 0, "code", {}));
check("rejects small context", !feasible(model("x", { contextLength: 100 }), env({ estimatedContextTokens: 1000 }), 0, "code", {}));
check("accepts ample context", feasible(model("x"), env({ estimatedContextTokens: 1000 }), 0, "code", {}));
check("rejects expired", !feasible(model("x", { expiresAt: 1 }), env(), 0, "code", {}));
check("rejects text-only when images present", !feasible(model("x", { inputModalities: ["text"] }), env({ hasImages: true }), 0, "code", {}));
check("accepts image model when images present", feasible(model("x"), env({ hasImages: true }), 0, "code", {}));
check("rejects no reasoning for code", !feasible(model("x", { supportsReasoning: false }), env(), 0, "code", {}));
check("allows no reasoning for writing", feasible(model("x", { supportsReasoning: false }), env(), 0, "writing", {}));

// --- proven gate ---
const unproven: EvidenceIndex = {};
const proven: EvidenceIndex = { "x": { code: { runs: PROVEN_RUNS, passes: PROVEN_RUNS, meanCostUsd: 0.05, meanLatencyMs: 900 } } };
check("high risk rejects unproven", !feasible(model("x"), env(), 2, "code", unproven));
check("high risk accepts proven", feasible(model("x"), env(), 2, "code", proven));
check("low risk accepts unproven", feasible(model("x"), env(), 1, "code", unproven));

// --- selection ---
const catalog = [
  model("cheap/flash", { promptPrice: 0.00000075, completionPrice: 0.00000375, aa: { intelligence: 40.9, coding: 76.3, agentic: 40.2 } }),
  model("mid/sonnet"),
  model("dear/fable", { promptPrice: 0.00001, completionPrice: 0.00005, aa: { intelligence: 53.4, coding: 81.6, agentic: 57.9 } }),
];

const writing = selectModel(env(), answers(1, 0) as any, catalog, {}, "frontier", "writing");
check("writing route is cheap", writing.modelId === "cheap/flash");
check("writing reason", writing.reason === "frontier_tangency");
check("reports candidate count", writing.candidateCount === 3);
check("reports frontier", Array.isArray(writing.frontier) && writing.frontier.length >= 1);

const planning = selectModel(env(), answers(3, 0) as any, catalog, {}, "frontier", "planning");
check("planning route favours quality", planning.modelId === "dear/fable");

const pinned = selectModel(env(), answers(1, 0) as any, catalog, {}, "empirical_cost", "code");
check("pinned profile bypasses frontier", pinned.modelId === "anthropic/claude-sonnet-5" && pinned.reason === "pinned_profile");

// --- relaxation ---
const risky = selectModel(env(), answers(1, 3) as any, catalog, {}, "frontier", "code");
check("relaxes proven gate when nothing qualifies", risky.reason === "relaxed_proven_gate");
check("relaxation still returns a model", risky.modelId.length > 0);

// --- classifier down ---
const down = selectModel(env(), { ok: false, classifierUnavailable: true, answers: {}, requestedModel: "j", resolvedModel: "j", latencyMs: 0 } as any, catalog, {}, "frontier", "code");
check("classifier down still selects", down.modelId.length > 0);
check("classifier down reason", down.reason === "classifier_unavailable");

// --- weights table shape ---
check("writing is the most cost averse", PROFILE_WEIGHTS.writing.lambda > PROFILE_WEIGHTS.code.lambda);
check("planning is the least cost averse", PROFILE_WEIGHTS.planning.lambda < PROFILE_WEIGHTS.code.lambda);

process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types tests/selector.test.ts`
Expected: FAIL, `selectModel is not a function` or a missing export error.

- [ ] **Step 3: Rewrite `src/selector.ts`**

Replace the whole file. Keep `resolveWorkKind` and `ROLE_THINKING` byte-identical to the current version.

```ts
/**
 * Model selection over the OpenRouter catalog.
 *
 * Pure functions only. No network call. No file read. The caller supplies the
 * catalog and the evidence. Jev output is evidence, never a guarantee.
 */
import type { CatalogModel } from "./catalog.ts";
import { statsFor, type EvidenceIndex } from "./evidence.ts";
import { nondominated, tangency, type Scored } from "./frontier.ts";
import type { ClassificationResult, TaskEnvelope } from "./task-envelope.ts";

export const K = 5;
export const PROVEN_RUNS = 3;
export const CONTEXT_HEADROOM = 1.3;
const DEFAULT_TURNS = 4;
const DEFAULT_OUTPUT_TOKENS = 1500;
const OPTIMISTIC_PERCENTILE = 0.6;

export type WorkKind = "planning" | "code" | "writing" | "other";
export type RouterProfile = "frontier" | "pareto_code" | "empirical_cost";

export interface Weights { lambda: number; mu: number }

export const PROFILE_WEIGHTS: Record<WorkKind, Weights> = {
  planning: { lambda: 0.15, mu: 0.05 },
  code: { lambda: 0.45, mu: 0.20 },
  writing: { lambda: 0.80, mu: 0.50 },
  other: { lambda: 0.50, mu: 0.25 },
};

/** Pinned profiles bypass the frontier. They exist so eval can measure against them. */
export const PINNED_MODELS: Record<"pareto_code" | "empirical_cost", Record<WorkKind, string>> = {
  pareto_code: {
    planning: "anthropic/claude-sonnet-5",
    code: "openrouter/pareto-code",
    writing: "openai/gpt-5.4-mini",
    other: "anthropic/claude-sonnet-5",
  },
  empirical_cost: {
    planning: "anthropic/claude-sonnet-5",
    code: "anthropic/claude-sonnet-5",
    writing: "openai/gpt-5.4-mini",
    other: "anthropic/claude-sonnet-5",
  },
};

export const ROLE_THINKING: Record<WorkKind, string> = {
  planning: "high",
  code: "medium",
  writing: "low",
  other: "medium",
};

export type RecommendationReason =
  | "frontier_tangency"
  | "pinned_profile"
  | "relaxed_proven_gate"
  | "relaxed_reasoning"
  | "catalog_unavailable"
  | "classifier_unavailable";

export interface Recommendation {
  modelId: string;
  reason: RecommendationReason;
  q?: number;
  cEst?: number;
  tEst?: number;
  candidateCount?: number;
  frontier?: Scored[];
  lambda?: number;
  mu?: number;
  complexity?: number;
  risk?: number;
  latencySignal?: boolean;
}

/** Map prompt text + Jev category -> work kind. Explicit role overrides this. */
export function resolveWorkKind(explicit?: string, category?: string, promptText?: string): WorkKind {
  if (explicit === "planning" || explicit === "code" || explicit === "writing") return explicit;
  const lower = (promptText ?? "").toLowerCase();
  if (/\b(architecture|architect|design (a|the|some|our)?|system design|rfc|spec|tradeoffs?|rollout plan|plan the)\b/.test(lower)) {
    return "planning";
  }
  if (/\b(write\b.*\b(blog|article|post|essay|copy|paragraph|prose|readme|summary|intro)|draft\b|humanize|polish the text|rewrite|simplified technical english|ste\b)\b/.test(lower)) {
    return "writing";
  }
  switch (category) {
    case "architecture": return "planning";
    case "implementation":
    case "debugging":
    case "mechanical_edit":
    case "review": return "code";
    case "lookup":
    case "explanation": return "writing";
    default: return "other";
  }
}

function aaIndexFor(m: CatalogModel, kind: WorkKind): number | null {
  if (!m.aa) return null;
  if (kind === "code") return m.aa.coding;
  if (kind === "other") return m.aa.agentic;
  return m.aa.intelligence;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0.5;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Normalised quality prior per model. Models without a benchmark entry receive
 * an optimistic prior so they can win low-risk work and earn evidence.
 */
export function qualityPrior(catalog: CatalogModel[], kind: WorkKind): Map<string, number> {
  const raw = new Map<string, number>();
  for (const m of catalog) {
    const v = aaIndexFor(m, kind);
    if (v !== null && Number.isFinite(v) && v > 0) raw.set(m.id, v);
  }
  const values = [...raw.values()];
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const span = hi - lo || 1;
  const normalised = new Map<string, number>();
  for (const [id, v] of raw) normalised.set(id, (v - lo) / span);
  const sorted = [...normalised.values()].sort((a, b) => a - b);
  const optimistic = percentile(sorted, OPTIMISTIC_PERCENTILE);
  const out = new Map<string, number>();
  for (const m of catalog) out.set(m.id, normalised.get(m.id) ?? optimistic);
  return out;
}

function needsReasoning(kind: WorkKind): boolean {
  return kind === "planning" || kind === "code";
}

export function feasible(
  m: CatalogModel,
  env: TaskEnvelope,
  risk: number,
  kind: WorkKind,
  evidence: EvidenceIndex,
  opts: { ignoreProvenGate?: boolean; ignoreReasoning?: boolean; now?: number } = {},
): boolean {
  const now = opts.now ?? Date.now();
  if (m.contextLength < env.facts.estimatedContextTokens * CONTEXT_HEADROOM) return false;
  if (!m.supportsTools) return false;
  if (!opts.ignoreReasoning && needsReasoning(kind) && !m.supportsReasoning) return false;
  if (!m.inputModalities.includes("text")) return false;
  if (env.facts.hasImages && !m.inputModalities.includes("image")) return false;
  if (m.expiresAt !== null && m.expiresAt <= now) return false;
  if (!opts.ignoreProvenGate && risk >= 2) {
    if ((statsFor(evidence, m.id, kind)?.runs ?? 0) < PROVEN_RUNS) return false;
  }
  return true;
}

function shrink(n: number): number {
  return n / (n + K);
}

function score(
  m: CatalogModel,
  env: TaskEnvelope,
  kind: WorkKind,
  evidence: EvidenceIndex,
  priors: Map<string, number>,
  latencyPrior: number,
): Scored {
  const st = statsFor(evidence, m.id, kind);
  const n = st?.runs ?? 0;
  const w = shrink(n);

  const qObs = st ? (st.passes + 1) / (st.runs + 2) : 0;
  const qPrior = priors.get(m.id) ?? 0.5;
  const q = w * qObs + (1 - w) * qPrior;

  const cEstimate =
    DEFAULT_TURNS *
    (m.promptPrice * env.facts.estimatedContextTokens + m.completionPrice * DEFAULT_OUTPUT_TOKENS);
  const c = w * (st?.meanCostUsd ?? 0) + (1 - w) * cEstimate;

  const t = w * (st?.meanLatencyMs ?? 0) + (1 - w) * latencyPrior;

  return { id: m.id, q, c, t };
}

/** Median observed latency for the kind, or zero when there is no signal. */
function latencySignal(evidence: EvidenceIndex, kind: WorkKind): { prior: number; present: boolean } {
  const observed: number[] = [];
  for (const kinds of Object.values(evidence)) {
    const st = kinds[kind];
    if (st && Number.isFinite(st.meanLatencyMs)) observed.push(st.meanLatencyMs);
  }
  if (observed.length < 2) return { prior: 0, present: false };
  observed.sort((a, b) => a - b);
  return { prior: observed[Math.floor(observed.length / 2)], present: true };
}

export function selectModel(
  env: TaskEnvelope,
  classification: ClassificationResult,
  catalog: CatalogModel[],
  evidence: EvidenceIndex,
  profile: RouterProfile,
  kind: WorkKind,
): Recommendation {
  if (profile !== "frontier") {
    return { modelId: PINNED_MODELS[profile][kind], reason: "pinned_profile" };
  }

  const answers = classification.answers ?? {};
  const complexity = typeof answers.complexity?.value === "number" ? answers.complexity.value : 1;
  const rawRisk = typeof answers.risk?.value === "number" ? answers.risk.value : 1;
  // A task that was not classified must not clear the proven gate on a guess.
  const risk = classification.classifierUnavailable ? 3 : rawRisk;

  if (catalog.length === 0) {
    return { modelId: PINNED_MODELS.empirical_cost[kind], reason: "catalog_unavailable" };
  }

  const priors = qualityPrior(catalog, kind);
  const { prior: latPrior, present: latPresent } = latencySignal(evidence, kind);

  const attempts: Array<{ opts: Parameters<typeof feasible>[5]; reason: RecommendationReason }> = [
    { opts: {}, reason: "frontier_tangency" },
    { opts: { ignoreProvenGate: true }, reason: "relaxed_proven_gate" },
    { opts: { ignoreProvenGate: true, ignoreReasoning: true }, reason: "relaxed_reasoning" },
  ];

  for (const attempt of attempts) {
    const candidates = catalog.filter((m) => feasible(m, env, risk, kind, evidence, attempt.opts));
    if (candidates.length === 0) continue;
    const scored = candidates.map((m) => score(m, env, kind, evidence, priors, latPrior));
    const front = nondominated(scored);
    const w = PROFILE_WEIGHTS[kind];
    const picked = tangency(front, w.lambda, latPresent ? w.mu : 0);
    if (!picked) continue;
    return {
      modelId: picked.pick.id,
      reason: classification.classifierUnavailable ? "classifier_unavailable" : attempt.reason,
      q: picked.pick.q,
      cEst: picked.pick.c,
      tEst: picked.pick.t,
      candidateCount: candidates.length,
      frontier: front,
      lambda: w.lambda,
      mu: latPresent ? w.mu : 0,
      complexity,
      risk,
      latencySignal: latPresent,
    };
  }

  return { modelId: PINNED_MODELS.empirical_cost[kind], reason: "catalog_unavailable" };
}
```

- [ ] **Step 4: Update `tests/role-routing.test.ts`**

Replace lines 18-31 (the `paretoModels` block through `roleAssertions`) with:

```ts
import { PINNED_MODELS, PROFILE_WEIGHTS, ROLE_THINKING, resolveWorkKind } from "../src/selector.ts";

const roleAssertions = [
  PINNED_MODELS.pareto_code.planning === "anthropic/claude-sonnet-5",
  PINNED_MODELS.pareto_code.code === "openrouter/pareto-code",
  PINNED_MODELS.pareto_code.writing === "openai/gpt-5.4-mini",
  PINNED_MODELS.empirical_cost.code === "anthropic/claude-sonnet-5",
  PROFILE_WEIGHTS.writing.lambda > PROFILE_WEIGHTS.code.lambda,
  PROFILE_WEIGHTS.planning.lambda < PROFILE_WEIGHTS.code.lambda,
  ROLE_THINKING.planning === "high",
  ROLE_THINKING.code === "medium",
  ROLE_THINKING.writing === "low",
];
```

Update the import on line 1 to match. Delete the old `PROFILE_MODELS` import.

- [ ] **Step 5: Run both tests**

Run:
```bash
node --experimental-strip-types tests/selector.test.ts
node --experimental-strip-types tests/role-routing.test.ts
```
Expected: every line `PASS`, exit 0 for both. `tests/worktree.test.ts` is untouched and still passes.

- [ ] **Step 6: Commit**

```bash
git add src/selector.ts tests/selector.test.ts tests/role-routing.test.ts
git commit -m "Select models from the catalog by Pareto frontier and tangency"
```

---

### Task 5: Repair dispatch and eval call sites

**Files:**
- Modify: `src/dispatch.ts:90-105`
- Modify: `eval/runner.ts:47-100`
- Modify: `eval/types.ts:13`
- Modify: `eval/index.ts:9-11`

**Interfaces:**
- Consumes: `selectModel`, `PINNED_MODELS`, `ROLE_THINKING`, `resolveWorkKind` from `src/selector.ts`; `loadCatalog` from `src/catalog.ts`; `loadEvidence` from `src/evidence.ts`.
- Produces: nothing new. This task restores a typechecking tree.

- [ ] **Step 1: Update `src/dispatch.ts`**

Change the import on line 18 from:

```ts
import { DEFAULT_POLICY, recommendByRole, resolveWorkKind, ROLE_THINKING } from "./selector.ts";
```

to:

```ts
import { selectModel, resolveWorkKind, ROLE_THINKING } from "./selector.ts";
import { loadCatalog } from "./catalog.ts";
import { loadEvidence } from "./evidence.ts";
```

Replace `policyRef` on line 97 with `policyRef: "policy@v2"`.

Replace lines 99-104 with:

```ts
  const c = await classify(envelope);
  const category = String((c.answers as any).category?.value ?? "");
  const workKind = resolveWorkKind(explicitRole, category, objective);
  const { models } = await loadCatalog();
  const evidence = loadEvidence();
  const r = selectModel(envelope, c, models, evidence, "frontier", workKind);
  const thinking = ROLE_THINKING[workKind];
  return { recommendation: r, thinking, classification: c, workKind };
```

The old `tierIndex` ternary is gone. `ROLE_THINKING` covers `other`.

- [ ] **Step 2: Update `eval/types.ts:13`**

```ts
export type RoutingStrategy = "fixed_frontier" | "router_role" | "router_frontier";
```

- [ ] **Step 3: Update `eval/index.ts`**

Change line 10 from `["fixed_frontier", "router_role", "router_tiered"]` to:

```ts
    ? ["fixed_frontier", "router_role", "router_frontier"]
```

- [ ] **Step 4: Update `eval/runner.ts`**

Change the import on line 9 to:

```ts
import { selectModel, resolveWorkKind, ROLE_THINKING, PINNED_MODELS } from "../src/selector.ts";
import { loadCatalog } from "../src/catalog.ts";
import { loadEvidence } from "../src/evidence.ts";
```

Replace the `router_role` block at lines 80-92 and the `router_tiered` block at lines 94 onward with:

```ts
  if (strategy === "router_role") {
    return {
      model: PINNED_MODELS.pareto_code[workKind],
      thinking: ROLE_THINKING[workKind],
      systemPromptAppend: workKind === "writing" ? WRITING_STYLE_DIRECTIVE : undefined,
      reason: `pinned:${workKind}`,
    };
  }

  // strategy === "router_frontier"
  const { models } = await loadCatalog();
  const evidence = loadEvidence();
  const recommendation = selectModel(envelope, classification, models, evidence, "frontier", workKind);
  return {
    model: recommendation.modelId,
    thinking: ROLE_THINKING[workKind],
    systemPromptAppend: workKind === "writing" ? WRITING_STYLE_DIRECTIVE : undefined,
    reason: `${recommendation.reason}:${workKind}`,
  };
```

Delete any remaining reference to `recommend`, `recommendByRole`, or `DEFAULT_POLICY` in this file.

- [ ] **Step 5: Verify the tree loads**

Run:
```bash
node --experimental-strip-types -e "import('./src/dispatch.ts').then(()=>console.log('dispatch ok'))"
node --experimental-strip-types -e "import('./eval/runner.ts').then(()=>console.log('runner ok'))"
```
Expected: `dispatch ok` and `runner ok`, no module or export errors.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all three suites pass, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/dispatch.ts eval/runner.ts eval/types.ts eval/index.ts
git commit -m "Point dispatch and the eval runner at the frontier selector"
```

---

### Task 6: Router extension, ledger and the frontier command

**Files:**
- Modify: `extensions/router.ts:24` (imports), `:108-140` (auto branch), `:300-335` (status output)
- Modify: `src/ledger.ts`

**Interfaces:**
- Consumes: `selectModel`, `PINNED_MODELS`, `ROLE_THINKING`, `resolveWorkKind`, `Recommendation` from `src/selector.ts`; `loadCatalog` from `src/catalog.ts`; `loadEvidence` from `src/evidence.ts`.
- Produces: `/router frontier` command output; ledger records carrying frontier fields.

- [ ] **Step 1: Read the current file**

Run: `sed -n '1,60p;100,145p;295,335p' extensions/router.ts`

Note the existing `profile` variable, the `switchModel` helper, and the `/router` command switch. Keep all of them.

- [ ] **Step 2: Update the imports on line 24**

```ts
import { selectModel, resolveWorkKind, PINNED_MODELS, PROFILE_WEIGHTS, ROLE_THINKING, type Recommendation, type WorkKind, type RouterProfile } from "../src/selector.ts";
import { loadCatalog, type CatalogModel } from "../src/catalog.ts";
import { loadEvidence, type EvidenceIndex } from "../src/evidence.ts";
```

- [ ] **Step 3: Add module-level caches near the other module state**

```ts
let catalogCache: CatalogModel[] = [];
let catalogSource: "network" | "cache" | "bootstrap" = "bootstrap";
let evidenceCache: EvidenceIndex = {};
let lastRecommendation: Recommendation | undefined;

async function ensureCatalog(): Promise<void> {
  if (catalogCache.length > 0) return;
  const loaded = await loadCatalog();
  catalogCache = loaded.models;
  catalogSource = loaded.source;
  evidenceCache = loadEvidence();
}
```

- [ ] **Step 4: Replace the auto branch body at lines 120-133**

Replace from `const category = String(...)` through the `recommendation.reason = ...` line with:

```ts
        const category = String((classification.answers as any)?.category?.value ?? "");
        const workKind = resolveWorkKind(undefined, category, event.prompt);
        await ensureCatalog();

        const picked = selectModel(
          { taskId: "live", role: "direct", objective: event.prompt, acceptanceCriteria: [], relevantContext: "",
            facts: { hasImages: false, estimatedContextTokens: Math.ceil(event.prompt.length / 4), requiredTools: [], attempt: 0, priorFailureKinds: [] },
            policyRef: "policy@v2" },
          classification,
          catalogCache,
          evidenceCache,
          profile,
          workKind,
        );
        lastRecommendation = picked;
        recommendation.modelId = picked.modelId;
        recommendation.reason = picked.reason;
        const roleThinking = ROLE_THINKING[workKind];
        const target = picked.modelId;
```

Leave the `switchModel` call, the `note` assignment, and the writing directive injection below it unchanged.

- [ ] **Step 5: Extend the ledger**

Open `src/ledger.ts`. Add these fields to the record type and to the write call:

```ts
  candidateCount?: number;
  frontierSize?: number;
  q?: number;
  cEst?: number;
  tEst?: number;
  lambda?: number;
  mu?: number;
  reason?: string;
```

Populate them from the `Recommendation` at the existing ledger write site in `extensions/router.ts`. `frontierSize` is `recommendation.frontier?.length`.

- [ ] **Step 6: Add the `/router frontier` subcommand**

In the `/router` command switch, add a branch before the default:

```ts
      if (sub === "frontier") {
        if (!lastRecommendation?.frontier) {
          ctx.ui.notify("jev-router: no frontier recorded yet — run a task in auto mode", "info");
          return;
        }
        const r = lastRecommendation;
        const rows = r.frontier!
          .slice()
          .sort((a, b) => a.c - b.c)
          .map((m) => `${m.id === r.modelId ? "*" : " "} ${m.id}  q=${m.q.toFixed(3)}  $${m.c.toFixed(4)}  ${Math.round(m.t)}ms`);
        ctx.ui.notify(
          [`jev-router frontier (${r.candidateCount} candidates -> ${r.frontier!.length} on frontier)`,
           `lambda=${r.lambda} mu=${r.mu} reason=${r.reason}`,
           ...rows].join("\n"),
          "info",
        );
        return;
      }
```

- [ ] **Step 7: Update the status output around line 327**

Replace the `allowlist:` line with:

```ts
            `catalog: ${catalogCache.length} models (${catalogSource})`,
            `weights: ${JSON.stringify(PROFILE_WEIGHTS)}`,
```

- [ ] **Step 8: Verify the extension loads and the suite passes**

Run:
```bash
node --experimental-strip-types -e "import('./extensions/router.ts').then(()=>console.log('router ok'))"
npm test
```
Expected: `router ok`, then all three suites pass.

- [ ] **Step 9: Commit**

```bash
git add extensions/router.ts src/ledger.ts
git commit -m "Route live turns through the frontier selector and add /router frontier"
```

---

### Task 7: Documentation and rules

**Files:**
- Modify: `AGENTS.md` (hard rule 5, architecture bullet for `src/selector.ts`, Files list)
- Modify: `README.md` (Model rules table, Commands, Files)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Replace AGENTS.md hard rule 5**

Current text:

> 5. Keep the model allowlist in `src/selector.ts` explicit. Never route to an unlisted model.

Replacement:

> 5. Route only to models the catalog lists as feasible for the task. A model with fewer than three recorded runs for the work kind cannot take a task with risk 2 or higher. The bootstrap list in `src/catalog.ts` applies only when the catalog is unavailable.

Leave hard rules 1, 2, 3, 4, 6, 7, and 8 unchanged.

- [ ] **Step 2: Update the AGENTS.md architecture section**

Replace the `src/selector.ts` bullet with:

```text
- `src/catalog.ts` fetches, caches and normalises the OpenRouter catalog. It owns every network call for model data.
- `src/evidence.ts` aggregates `eval/results` into per-model, per-work-kind statistics.
- `src/frontier.ts` computes Pareto dominance and the tangency point. Pure functions.
- `src/selector.ts` scores models and selects one. Pure functions. No network calls. No file reads. The caller supplies the catalog and the evidence.
```

- [ ] **Step 3: Update the README Model rules section**

Replace the table with:

```markdown
## Model rules

The router ranks the whole OpenRouter catalog for each task. It filters the
catalog to models that fit the task, computes a Pareto frontier over quality,
cost and latency, then picks one point on that frontier.

Quality blends recorded runs from `eval/results` with the Artificial Analysis
indices the catalog carries. Evidence replaces the benchmark prior as runs
accumulate.

| Role | Cost weight | Latency weight | Thinking |
|---|---|---|---|
| Planning | 0.15 | 0.05 | high |
| Code | 0.45 | 0.20 | medium |
| Writing | 0.80 | 0.50 | low |

A model with fewer than three recorded runs for the work kind cannot take a
task with risk 2 or higher.
```

- [ ] **Step 4: Add the new command to the README command list**

```text
/router frontier show the frontier behind the last decision
```

- [ ] **Step 5: Update the README Files list**

```markdown
- `src/classifier.ts` — Jev call. One request, five questions.
- `src/catalog.ts` — OpenRouter catalog fetch and cache.
- `src/evidence.ts` — recorded runs aggregated per model and work kind.
- `src/frontier.ts` — Pareto dominance and tangency.
- `src/selector.ts` — scoring and selection. No model calls.
- `src/board.ts` — SQLite task state.
- `src/dispatch.ts` — worker spawn and handshake.
- `extensions/router.ts` — pi hooks and commands.
- `eval/` — benchmark tasks, verifiers, runner.
```

- [ ] **Step 6: Verify the suite still passes**

Run: `npm test`
Expected: all three suites pass, exit 0.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md README.md
git commit -m "Document catalog-driven selection and revise hard rule 5"
```

---

## After the plan

Run the benchmark to measure the new profile against both pinned profiles:

```bash
node --experimental-strip-types eval/index.ts --all
```

This produces the three-way comparison the design was built to answer: does
frontier selection beat `empirical_cost`, and does it beat `pareto_code`. Do not
tune `lambda` or `mu` before this run. The first measurement must be of the
starting values.

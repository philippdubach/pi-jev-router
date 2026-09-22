/**
 * Discriminating benchmark tasks.
 *
 * The original five tasks were passed by every model tried, so the recorded
 * pass rate carried no quality signal. These tasks each have one specific
 * failure mode that a weaker model is likely to hit, and a verifier that
 * detects exactly that failure rather than general completion.
 *
 * Each verifier includes a positive control: it must fail against the
 * unmodified starting state. A check that passes before any work is done
 * proves nothing.
 */
import type { BenchmarkTask } from "./types.ts";
import { verifyStrictSTE } from "./hard-verifiers.ts";

export const HARD_TASKS: BenchmarkTask[] = [
  {
    // Failure mode: treating check-then-act as atomic. A naive fix guards the
    // write but still allows two callers past the staleness check, so the
    // origin runs twice for one key.
    id: "code_cache_stampede",
    name: "Fix a cache stampede under concurrent access",
    kind: "code",
    prompt:
      "`cache.ts` has a concurrency bug. Under concurrent `get()` calls for the same missing key, the loader runs more than once. " +
      "Fix it so the loader runs exactly once per key per refresh, while concurrent callers all receive the value. " +
      "Keep the public API unchanged. Do not modify `test.ts`. All tests must pass.",
    setupFiles: {
      "cache.ts": `
export type Loader<V> = (key: string) => Promise<V>;

interface Entry<V> { value: V; expiresAt: number }

/** BUG: concurrent misses each start their own load. */
export class AsyncCache<V> {
  private store = new Map<string, Entry<V>>();
  private loader: Loader<V>;
  private ttlMs: number;

  constructor(loader: Loader<V>, ttlMs = 50) {
    this.loader = loader;
    this.ttlMs = ttlMs;
  }

  async get(key: string): Promise<V> {
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await this.loader(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }

  size(): number { return this.store.size; }
}
`,
      "test.ts": `
import { AsyncCache } from "./cache.ts";

function assert(c: boolean, m: string) { if (!c) throw new Error("Assertion failed: " + m); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // 1. Concurrent misses must collapse into a single load.
  let calls = 0;
  const cache = new AsyncCache<string>(async (k) => { calls++; await sleep(30); return "v:" + k; }, 1000);
  const results = await Promise.all([cache.get("a"), cache.get("a"), cache.get("a"), cache.get("a")]);
  assert(calls === 1, "loader must run once for concurrent misses, ran " + calls);
  assert(results.every((r) => r === "v:a"), "all concurrent callers get the value");

  // 2. Distinct keys still load independently.
  let calls2 = 0;
  const c2 = new AsyncCache<string>(async (k) => { calls2++; await sleep(10); return k; }, 1000);
  await Promise.all([c2.get("x"), c2.get("y")]);
  assert(calls2 === 2, "distinct keys load separately, got " + calls2);

  // 3. A failed load must not be cached, and must reject every waiter.
  let attempts = 0;
  const c3 = new AsyncCache<string>(async () => { attempts++; throw new Error("upstream"); }, 1000);
  const settled = await Promise.allSettled([c3.get("k"), c3.get("k")]);
  assert(settled.every((s) => s.status === "rejected"), "all waiters reject on loader failure");
  assert(attempts === 1, "failed load is shared, not repeated per caller, got " + attempts);
  const retry = await Promise.allSettled([c3.get("k")]);
  assert(retry[0].status === "rejected" && attempts === 2, "a later call retries after failure");

  // 4. Expiry triggers exactly one refresh.
  let calls4 = 0;
  const c4 = new AsyncCache<number>(async () => { calls4++; await sleep(5); return calls4; }, 40);
  await c4.get("k");
  await sleep(60);
  await Promise.all([c4.get("k"), c4.get("k")]);
  assert(calls4 === 2, "expiry causes one refresh, got " + calls4);

  console.log("ALL CACHE TESTS PASSED");
}
run().catch((e) => { console.error(e.message); process.exit(1); });
`,
    },
    verifierCommand: "node --experimental-strip-types test.ts",
  },
  {
    // Failure mode: renaming the symbol where it is defined and where it is
    // obviously called, but missing the re-export barrel, the dynamic lookup
    // keyed by string, and the type-only import.
    id: "code_multifile_rename",
    name: "Rename a symbol consistently across modules",
    kind: "code",
    prompt:
      "Rename the exported `computeTotal` function to `calculateOrderTotal` across the whole codebase, including every import, " +
      "re-export, type reference and string-keyed registry entry. Update `handlers.ts`, `registry.ts`, `index.ts` and `totals.ts` as needed. " +
      "The old name must not appear anywhere. Do not modify `test.ts`. All tests must pass.",
    setupFiles: {
      "totals.ts": `
export interface Order { items: { price: number; qty: number }[]; taxRate: number }

export function computeTotal(order: Order): number {
  const sub = order.items.reduce((s, i) => s + i.price * i.qty, 0);
  return Math.round(sub * (1 + order.taxRate) * 100) / 100;
}

export type TotalFn = typeof computeTotal;
`,
      "handlers.ts": `
import { computeTotal, type Order } from "./totals.ts";

export function handleCheckout(order: Order): string {
  return "Total: " + computeTotal(order).toFixed(2);
}
`,
      "registry.ts": `
import { computeTotal } from "./totals.ts";
import type { TotalFn } from "./totals.ts";

// A string-keyed registry. The key must track the function name.
export const calculators: Record<string, TotalFn> = {
  computeTotal,
};

export function callByName(name: string, order: any): number {
  const fn = calculators[name];
  if (!fn) throw new Error("no calculator named " + name);
  return fn(order);
}
`,
      "index.ts": `
export { computeTotal } from "./totals.ts";
export { handleCheckout } from "./handlers.ts";
export { calculators, callByName } from "./registry.ts";
`,
      "test.ts": `
import { readFileSync, readdirSync } from "node:fs";
import * as api from "./index.ts";
import { callByName, calculators } from "./registry.ts";
import { handleCheckout } from "./handlers.ts";

function assert(c: boolean, m: string) { if (!c) throw new Error("Assertion failed: " + m); }

const order = { items: [{ price: 10, qty: 2 }, { price: 5, qty: 1 }], taxRate: 0.1 };

assert(typeof (api as any).calculateOrderTotal === "function", "index must re-export calculateOrderTotal");
assert((api as any).computeTotal === undefined, "the old export must be gone from index");
assert((api as any).calculateOrderTotal(order) === 27.5, "renamed function still computes correctly");
assert(handleCheckout(order) === "Total: 27.50", "handler still works");
assert("calculateOrderTotal" in calculators, "registry key must be renamed");
assert(!("computeTotal" in calculators), "old registry key must be gone");
assert(callByName("calculateOrderTotal", order) === 27.5, "lookup by new name works");

// The old identifier must not survive anywhere in the sources.
for (const f of readdirSync(".").filter((n) => n.endsWith(".ts") && n !== "test.ts")) {
  const src = readFileSync(f, "utf8");
  assert(!/\\bcomputeTotal\\b/.test(src), "stale name computeTotal still present in " + f);
}

console.log("ALL RENAME TESTS PASSED");
`,
    },
    verifierCommand: "node --experimental-strip-types test.ts",
  },
  {
    // Failure mode: producing fluent prose that ignores the hard sentence-length
    // and voice limits. The earlier STE check allowed 20% long sentences and
    // only screened a short word list, so everything passed.
    id: "write_strict_ste",
    name: "Write a runbook under strict Simplified Technical English limits",
    kind: "writing",
    prompt:
      "Write an operations runbook for restarting a stuck message queue consumer. Save it to `runbook.md`. " +
      "Hard requirements: every sentence must be 20 words or fewer; use active voice throughout; one instruction per sentence; " +
      "no sentence may contain 'and' joining two separate instructions; include the sections Purpose, Preconditions, Steps, Verification, Rollback; " +
      "the Steps section must be a numbered list where every step begins with an imperative verb; " +
      "use no AI filler words and no marketing language.",
    setupFiles: {},
    customVerifier: verifyStrictSTE,
  },
];

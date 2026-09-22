/**
 * Code tasks with a capability ceiling.
 *
 * The first round of hard code tasks was passed by every model, because each
 * had a canonical published solution. Recognising a named pattern is easier
 * than reasoning about one. These three remove that shortcut:
 *
 *  - the cause sits two modules away from the failing assertion
 *  - the visible suite is partial and a hidden suite checks the rest
 *  - the fix must hold a whole-file invariant, not a single call site
 *
 * Every prompt states the full specification, so the hidden tests check only
 * behaviour the model was told about.
 */
import type { BenchmarkTask } from "./types.ts";
import { hiddenVerifier } from "./hidden-verifier.ts";

export const CEILING_TASKS: BenchmarkTask[] = [
  {
    // The assertion fires in the service layer. The service is correct. The
    // config merge is correct in isolation. The parser emits `undefined` for
    // absent optional keys, and those undefined values overwrite the defaults.
    id: "code_distant_cause",
    name: "Fix a default that is overwritten two modules away",
    kind: "code",
    maxTurns: 12,
    prompt:
      "`app.ts` reports the wrong timeout and the wrong retry count. The failing assertion is in the service layer, " +
      "but the cause is not there. Find it and fix it. " +
      "Specification: `parseConfig` returns only the keys actually present in the input text. " +
      "`mergeConfig` applies defaults, then overrides them with any key the user actually set. " +
      "A key the user did not set must keep its default. An explicit `0` or empty string from the user is a real value and must win. " +
      "Do not change `DEFAULTS`, and do not modify `test.ts`. All tests must pass.",
    setupFiles: {
      "parse.ts": `
export interface RawConfig {
  timeoutMs?: number;
  retries?: number;
  endpoint?: string;
}

/** Parse "key=value" lines. Unknown keys are ignored. */
export function parseConfig(text: string): RawConfig {
  const lines = text.split("\\n").map((l) => l.trim()).filter(Boolean);
  const get = (key: string): string | undefined => {
    const hit = lines.find((l) => l.startsWith(key + "="));
    return hit === undefined ? undefined : hit.slice(key.length + 1).trim();
  };
  const timeout = get("timeoutMs");
  const retries = get("retries");
  const endpoint = get("endpoint");
  return {
    timeoutMs: timeout === undefined ? undefined : Number(timeout),
    retries: retries === undefined ? undefined : Number(retries),
    endpoint: endpoint,
  };
}
`,
      "config.ts": `
import type { RawConfig } from "./parse.ts";

export const DEFAULTS = { timeoutMs: 30000, retries: 3, endpoint: "https://api.example.com" };
export type Config = typeof DEFAULTS;

export function mergeConfig(raw: RawConfig): Config {
  return Object.assign({}, DEFAULTS, raw);
}
`,
      "service.ts": `
import { mergeConfig, type Config } from "./config.ts";
import { parseConfig } from "./parse.ts";

export function loadService(text: string): Config {
  return mergeConfig(parseConfig(text));
}
`,
      "app.ts": `
export { loadService } from "./service.ts";
export { DEFAULTS } from "./config.ts";
`,
      "test.ts": `
import { loadService, DEFAULTS } from "./app.ts";

function assert(c: boolean, m: string) { if (!c) throw new Error("Assertion failed: " + m); }

// The user set only the endpoint. Everything else must keep its default.
const cfg = loadService("endpoint=https://prod.example.com");
assert(cfg.endpoint === "https://prod.example.com", "endpoint is taken from input");
assert(cfg.timeoutMs === DEFAULTS.timeoutMs, "timeout keeps its default, got " + cfg.timeoutMs);
assert(cfg.retries === DEFAULTS.retries, "retries keeps its default, got " + cfg.retries);

console.log("VISIBLE CONFIG TESTS PASSED");
`,
    },
    customVerifier: hiddenVerifier(`
import { loadService, DEFAULTS } from "./app.ts";

function assert(c: boolean, m: string) { if (!c) throw new Error("Assertion failed: " + m); }

// Explicit zero must win over the default. A truthiness-based merge fails here.
const zero = loadService("retries=0");
assert(zero.retries === 0, "explicit retries=0 must override the default, got " + zero.retries);

// Explicit empty string must win too.
const empty = loadService("endpoint=");
assert(empty.endpoint === "", "explicit empty endpoint must override the default, got " + JSON.stringify(empty.endpoint));

// Every key set at once.
const all = loadService("timeoutMs=100\\nretries=9\\nendpoint=https://x.test");
assert(all.timeoutMs === 100 && all.retries === 9 && all.endpoint === "https://x.test", "all keys honoured");

// Nothing set at all: pure defaults.
const none = loadService("");
assert(none.timeoutMs === DEFAULTS.timeoutMs && none.retries === DEFAULTS.retries && none.endpoint === DEFAULTS.endpoint, "empty input yields defaults");

// Unknown keys must not leak into the result.
const unknown: any = loadService("nonsense=1\\nretries=2");
assert(unknown.nonsense === undefined, "unknown keys must not appear");
assert(unknown.retries === 2, "known key still parsed alongside unknown");

// The defaults object must not have been mutated by any merge.
assert(DEFAULTS.retries === 3 && DEFAULTS.timeoutMs === 30000, "DEFAULTS must never be mutated");

console.log("HIDDEN CONFIG TESTS PASSED");
`),
  },
  {
    // The visible suite covers the easy half of the spec. The hidden suite
    // covers adjacency, containment, unsorted input, and single-point ranges,
    // all of which the prompt states.
    id: "code_interval_merge",
    name: "Implement interval merging against a partly hidden suite",
    kind: "code",
    maxTurns: 12,
    prompt:
      "Implement `mergeIntervals` in `intervals.ts`. " +
      "Specification: the input is an array of `[start, end]` pairs with `start <= end`, in any order. " +
      "Return the smallest array of non-overlapping intervals covering the same points, sorted ascending by start. " +
      "Intervals that overlap must merge. Intervals that merely touch, where one ends exactly where the next begins, must also merge. " +
      "An interval fully contained in another disappears into it. A single-point interval where start equals end is valid and must be preserved when isolated. " +
      "The input array must not be modified. An empty input returns an empty array. " +
      "The visible tests cover part of this. Your implementation is also checked against additional tests for the rest of the specification. " +
      "Do not modify `test.ts`.",
    setupFiles: {
      "intervals.ts": `
export type Interval = [number, number];

export function mergeIntervals(input: Interval[]): Interval[] {
  throw new Error("not implemented");
}
`,
      "test.ts": `
import { mergeIntervals, type Interval } from "./intervals.ts";

function assert(c: boolean, m: string) { if (!c) throw new Error("Assertion failed: " + m); }
const eq = (a: Interval[], b: Interval[]) => JSON.stringify(a) === JSON.stringify(b);

assert(eq(mergeIntervals([]), []), "empty input");
assert(eq(mergeIntervals([[1, 3]]), [[1, 3]]), "single interval");
assert(eq(mergeIntervals([[1, 3], [2, 6]]), [[1, 6]]), "simple overlap");
assert(eq(mergeIntervals([[1, 2], [5, 6]]), [[1, 2], [5, 6]]), "disjoint intervals stay separate");

console.log("VISIBLE INTERVAL TESTS PASSED");
`,
    },
    customVerifier: hiddenVerifier(`
import { mergeIntervals, type Interval } from "./intervals.ts";

function assert(c: boolean, m: string) { if (!c) throw new Error("Assertion failed: " + m); }
const eq = (a: Interval[], b: Interval[]) => JSON.stringify(a) === JSON.stringify(b);

// Unsorted input.
assert(eq(mergeIntervals([[5, 6], [1, 3]]), [[1, 3], [5, 6]]), "unsorted input is sorted");
assert(eq(mergeIntervals([[8, 10], [1, 3], [2, 6], [15, 18]]), [[1, 6], [8, 10], [15, 18]]), "unsorted with overlap");

// Touching intervals merge.
assert(eq(mergeIntervals([[1, 2], [2, 3]]), [[1, 3]]), "touching intervals merge");
assert(eq(mergeIntervals([[1, 2], [2, 3], [3, 4]]), [[1, 4]]), "chain of touching intervals");

// Containment.
assert(eq(mergeIntervals([[1, 10], [2, 3]]), [[1, 10]]), "contained interval disappears");
assert(eq(mergeIntervals([[2, 3], [1, 10]]), [[1, 10]]), "containment regardless of order");

// Single points.
assert(eq(mergeIntervals([[4, 4]]), [[4, 4]]), "isolated single point preserved");
assert(eq(mergeIntervals([[1, 2], [4, 4], [6, 7]]), [[1, 2], [4, 4], [6, 7]]), "single point among others");
assert(eq(mergeIntervals([[1, 5], [3, 3]]), [[1, 5]]), "single point inside a range merges");

// Purity.
const input: Interval[] = [[3, 4], [1, 2]];
const copy = JSON.stringify(input);
mergeIntervals(input);
assert(JSON.stringify(input) === copy, "input array must not be modified");

// Negative and large values.
assert(eq(mergeIntervals([[-5, -3], [-4, -1]]), [[-5, -1]]), "negative ranges merge");

console.log("HIDDEN INTERVAL TESTS PASSED");
`),
  },
  {
    // A whole-file invariant. Adding the field is easy; keeping every consumer
    // and the exhaustive switch consistent is the part that separates models.
    id: "code_thread_field",
    name: "Thread a new field through every consumer",
    kind: "code",
    maxTurns: 12,
    prompt:
      "Add a `priority` field to the event pipeline. " +
      "Specification: `priority` is one of `low`, `normal` or `high`, and defaults to `normal` when an event omits it. " +
      "`createEvent` accepts an optional priority. `describe` must include the priority in its output, formatted as `[PRIORITY]` in upper case at the start of the string. " +
      "`route` must send `high` events to the `urgent` queue, and everything else to the queue it already uses. " +
      "`summarise` must count events by priority and return the counts keyed by priority name, including zero counts for unused priorities. " +
      "Keep the existing behaviour for every other field. Do not modify `test.ts`.",
    setupFiles: {
      "events.ts": `
export type EventKind = "created" | "updated" | "deleted";

export interface DomainEvent {
  id: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

export function createEvent(id: string, kind: EventKind, payload: Record<string, unknown> = {}): DomainEvent {
  return { id, kind, payload };
}
`,
      "describe.ts": `
import type { DomainEvent } from "./events.ts";

export function describe(e: DomainEvent): string {
  return e.kind.toUpperCase() + " " + e.id;
}
`,
      "route.ts": `
import type { DomainEvent } from "./events.ts";

export function route(e: DomainEvent): string {
  switch (e.kind) {
    case "created": return "ingest";
    case "updated": return "ingest";
    case "deleted": return "audit";
  }
}
`,
      "summarise.ts": `
import type { DomainEvent } from "./events.ts";

export function summarise(events: DomainEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}
`,
      "index.ts": `
export * from "./events.ts";
export { describe } from "./describe.ts";
export { route } from "./route.ts";
export { summarise } from "./summarise.ts";
`,
      "test.ts": `
import { createEvent, describe, route } from "./index.ts";

function assert(c: boolean, m: string) { if (!c) throw new Error("Assertion failed: " + m); }

const plain = createEvent("e1", "created");
assert((plain as any).priority === "normal", "priority defaults to normal, got " + (plain as any).priority);
assert(describe(plain) === "[NORMAL] CREATED e1", "describe includes priority, got " + describe(plain));
assert(route(plain) === "ingest", "normal events keep their queue");

const urgent = createEvent("e2", "updated", {}, "high" as any);
assert(route(urgent) === "urgent", "high priority routes to urgent, got " + route(urgent));

console.log("VISIBLE EVENT TESTS PASSED");
`,
    },
    customVerifier: hiddenVerifier(`
import { createEvent, describe, route, summarise } from "./index.ts";

function assert(c: boolean, m: string) { if (!c) throw new Error("Assertion failed: " + m); }

// Every priority describes correctly.
assert(describe(createEvent("a", "deleted", {}, "low" as any)) === "[LOW] DELETED a", "low priority described");
assert(describe(createEvent("b", "created", {}, "high" as any)) === "[HIGH] CREATED b", "high priority described");

// Routing: only high changes queue, and the deleted->audit rule survives.
assert(route(createEvent("c", "deleted")) === "audit", "deleted still routes to audit");
assert(route(createEvent("d", "deleted", {}, "high" as any)) === "urgent", "high beats the kind rule");
assert(route(createEvent("e", "updated", {}, "low" as any)) === "ingest", "low keeps the existing queue");

// Summarise counts by priority, including zero counts.
const counts = summarise([
  createEvent("1", "created", {}, "high" as any),
  createEvent("2", "created", {}, "high" as any),
  createEvent("3", "updated"),
]);
assert(counts.high === 2, "two high events, got " + counts.high);
assert(counts.normal === 1, "one normal event, got " + counts.normal);
assert(counts.low === 0, "zero low events must still be reported, got " + counts.low);

// Existing fields untouched.
const withPayload = createEvent("f", "updated", { a: 1 });
assert(withPayload.payload.a === 1 && withPayload.id === "f" && withPayload.kind === "updated", "other fields preserved");

console.log("HIDDEN EVENT TESTS PASSED");
`),
  },
];

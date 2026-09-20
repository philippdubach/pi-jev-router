import type { BenchmarkTask } from "./types.ts";
import { verifyCommand, verifyPlanningArchitecture, verifyWritingSTE } from "./verifiers.ts";

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    id: "code_lru_ttl",
    name: "Implement LRU Cache with TTL in TypeScript",
    kind: "code",
    prompt:
      "Implement an in-memory LRU Cache with TTL support in `index.ts`. Export a class `LRUCache<K, V>`. " +
      "The constructor should accept `capacity: number`. " +
      "Implement `get(key: K): V | undefined`, `set(key: K, value: V, ttlMs?: number): void`, `size(): number`, `clear(): void`. " +
      "Expired keys must be evicted when accessed or when space is needed. Accessing a key refreshes its LRU recency. " +
      "All unit tests in `test.ts` must pass. Do not modify `test.ts`.",
    setupFiles: {
      "test.ts": `
import { LRUCache } from "./index.ts";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error("Assertion failed: " + msg);
}

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function runTests() {
  console.log("Running LRUCache tests...");
  
  // 1. Basic put and get
  const cache = new LRUCache<string, number>(3);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert(cache.get("a") === 1, "get('a') should return 1");
  assert(cache.size() === 3, "size should be 3");

  // 2. LRU eviction
  cache.get("a"); // touches 'a' -> recency order now: b, c, a
  cache.set("d", 4); // should evict 'b'
  assert(cache.get("b") === undefined, "'b' should be evicted");
  assert(cache.get("a") === 1, "'a' should still exist");
  assert(cache.get("c") === 3, "'c' should still exist");
  assert(cache.get("d") === 4, "'d' should exist");

  // 3. TTL expiration
  const ttlCache = new LRUCache<string, string>(2);
  ttlCache.set("temp", "val", 50); // 50ms TTL
  assert(ttlCache.get("temp") === "val", "immediate get should succeed");
  await sleep(80);
  assert(ttlCache.get("temp") === undefined, "expired key should return undefined");

  // 4. Overwrite existing key
  const updateCache = new LRUCache<string, string>(2);
  updateCache.set("k", "v1");
  updateCache.set("k", "v2");
  assert(updateCache.get("k") === "v2", "value should update");
  assert(updateCache.size() === 1, "size should remain 1");

  // 5. Clear
  updateCache.clear();
  assert(updateCache.size() === 0, "size after clear should be 0");
  assert(updateCache.get("k") === undefined, "get after clear should be undefined");

  console.log("ALL LRU TESTS PASSED");
}

runTests().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
`,
    },
    verifierCommand: "node --experimental-strip-types test.ts",
  },
  {
    id: "code_semver_sort",
    name: "Fix SemVer pre-release sorting and build metadata",
    kind: "code",
    prompt:
      "Fix the bugs in `semver.ts`. Currently prerelease versions like `1.0.0-alpha` and `1.0.0-beta.1` are sorted incorrectly, " +
      "and build metadata `+build` is improperly compared. " +
      "Make all unit tests in `test.ts` pass without modifying `test.ts`.",
    setupFiles: {
      "semver.ts": `
// BUGGY implementation that needs fixing
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string[];
  build?: string[];
}

export function parseSemVer(v: string): SemVer {
  const [main, ...rest] = v.split(/[+-]/);
  const [major, minor, patch] = main.split(".").map(Number);
  return { major, minor, patch }; // BUG: completely ignores prerelease and build!
}

export function compareSemVer(aStr: string, bStr: string): number {
  const a = parseSemVer(aStr);
  const b = parseSemVer(bStr);
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  return 0; // BUG: fails to compare prereleases!
}
`,
      "test.ts": `
import { compareSemVer, parseSemVer } from "./semver.ts";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error("Assertion failed: " + msg);
}

function runTests() {
  console.log("Running SemVer tests...");

  // 1. Basic version comparisons
  assert(compareSemVer("1.0.0", "2.0.0") < 0, "1.0.0 < 2.0.0");
  assert(compareSemVer("2.1.0", "2.0.9") > 0, "2.1.0 > 2.0.9");
  assert(compareSemVer("1.2.3", "1.2.3") === 0, "1.2.3 === 1.2.3");

  // 2. Prerelease precedes normal release
  assert(compareSemVer("1.0.0-alpha", "1.0.0") < 0, "1.0.0-alpha < 1.0.0");
  assert(compareSemVer("1.0.0-beta", "1.0.0-alpha") > 0, "1.0.0-beta > 1.0.0-alpha");
  assert(compareSemVer("1.0.0-alpha.1", "1.0.0-alpha") > 0, "1.0.0-alpha.1 > 1.0.0-alpha");
  assert(compareSemVer("1.0.0-alpha.1", "1.0.0-alpha.beta") < 0, "alpha.1 < alpha.beta (numeric precedes string)");

  // 3. Build metadata is ignored in precedence
  assert(compareSemVer("1.0.0+20130313144700", "1.0.0") === 0, "Build metadata should be ignored in compare");
  assert(compareSemVer("1.0.0-beta+exp.sha.5114f85", "1.0.0-beta") === 0, "Build metadata ignored on prerelease");

  console.log("ALL SEMVER TESTS PASSED");
}

runTests();
`,
    },
    verifierCommand: "node --experimental-strip-types test.ts",
  },
  {
    id: "code_retry_queue",
    name: "Implement Concurrency-Limited Async Queue with Retries",
    kind: "code",
    prompt:
      "Implement a concurrency-limited async task queue in `queue.ts`. " +
      "Export class `TaskQueue` with constructor `new TaskQueue({ concurrency: number, maxRetries?: number })`. " +
      "Method: `add<T>(task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>`. " +
      "Tasks must execute with at most `concurrency` concurrently active. " +
      "If a task throws, retry it up to `maxRetries` times before propagating failure. " +
      "If the passed `AbortSignal` is triggered, abort execution and reject immediately. " +
      "All tests in `test.ts` must pass. Do not modify `test.ts`.",
    setupFiles: {
      "test.ts": `
import { TaskQueue } from "./queue.ts";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error("Assertion failed: " + msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTests() {
  console.log("Running TaskQueue tests...");

  // 1. Concurrency limit
  const q = new TaskQueue({ concurrency: 2, maxRetries: 0 });
  let active = 0;
  let maxActive = 0;

  const makeTask = (delay: number) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(delay);
    active--;
    return delay;
  };

  const p1 = q.add(makeTask(50));
  const p2 = q.add(makeTask(50));
  const p3 = q.add(makeTask(50));

  await Promise.all([p1, p2, p3]);
  assert(maxActive <= 2, "Max active should not exceed concurrency 2 (was " + maxActive + ")");

  // 2. Retries on failure
  const retryQueue = new TaskQueue({ concurrency: 1, maxRetries: 2 });
  let attempts = 0;
  const flake = await retryQueue.add(async () => {
    attempts++;
    if (attempts < 3) throw new Error("transient error " + attempts);
    return "success-on-3";
  });
  assert(flake === "success-on-3", "Task should succeed on 3rd attempt");
  assert(attempts === 3, "Should have attempted 3 times");

  // 3. Abort signal
  const abortQueue = new TaskQueue({ concurrency: 1, maxRetries: 0 });
  const controller = new AbortController();
  controller.abort();
  let aborted = false;
  try {
    await abortQueue.add(async () => "never", controller.signal);
  } catch {
    aborted = true;
  }
  assert(aborted, "Aborted task must reject");

  console.log("ALL QUEUE TESTS PASSED");
}

runTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
`,
    },
    verifierCommand: "node --experimental-strip-types test.ts",
  },
  {
    id: "plan_distributed_ratelimiter",
    name: "Architect Distributed Multi-Region Rate Limiter",
    kind: "planning",
    prompt:
      "Design a distributed rate limiter for a multi-region API in `architecture.md`. " +
      "Include: " +
      "1) System Architecture & Component Design (Redis Token Bucket / Sliding Window) " +
      "2) Atomic Concurrency Control (specify Redis Lua script) " +
      "3) Failure Modes & Redis Outage Fallback Strategy " +
      "4) Blast Radius Mitigation & Rollback Triggers/Criteria with concrete metrics. " +
      "Save the complete plan into `architecture.md`.",
    setupFiles: {},
    customVerifier: verifyPlanningArchitecture,
  },
  {
    id: "write_incident_postmortem",
    name: "Technical Incident Postmortem in Simplified Technical English",
    kind: "writing",
    prompt:
      "Write an incident postmortem for a 45-minute database connection pool exhaustion outage. " +
      "Save the report to `incident-postmortem.md`. " +
      "Requirements: " +
      "- Sections required: Summary, Impact, Timeline, Root Cause, Action Items. " +
      "- Strictly adhere to Simplified Technical English (STE): short sentences (under 20 words per sentence), active voice, one idea per sentence, no nominalizations. " +
      "- Strictly adhere to Humanizer rules: no AI cliches or filler words (no 'delve', 'testament', 'tapestry', 'furthermore', 'moreover', 'in summary', 'not only... but also', 'pivotal', 'crucial').",
    setupFiles: {},
    customVerifier: verifyWritingSTE,
  },
];

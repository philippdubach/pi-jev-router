import { FALLBACK_MODELS, PROFILE_WEIGHTS, ROLE_THINKING, resolveWorkKind } from "../src/selector.ts";

const cases: Array<[string, string, string]> = [
  ["Plan the rollout strategy for an OAuth migration", "architecture", "planning"],
  ["Implement an LRU cache in TypeScript with unit tests", "implementation", "code"],
  ["Review this pull request for correctness and regressions", "review", "code"],
  ["Write a 150-word product announcement blog post", "unclear", "writing"],
];

let failed = 0;
for (const [prompt, category, expected] of cases) {
  const actual = resolveWorkKind(undefined, category, prompt);
  const ok = actual === expected;
  console.log(ok ? "PASS" : "FAIL", `${actual} <- ${prompt}`);
  if (!ok) failed++;
}

// Selection itself is weightless: the router picks the knee point, so there is
// no per-role model table. The fallback table only answers when the catalog is
// unavailable, and every entry must name a model that can serve that work.
const roleAssertions = [
  FALLBACK_MODELS.planning === "anthropic/claude-sonnet-5",
  FALLBACK_MODELS.code === "anthropic/claude-sonnet-5",
  FALLBACK_MODELS.writing === "deepseek/deepseek-v4-flash-0731",
  Object.values(FALLBACK_MODELS).every((id) => id.includes("/")),
  ROLE_THINKING.planning === "high",
  ROLE_THINKING.code === "medium",
  ROLE_THINKING.writing === "low",
  PROFILE_WEIGHTS.writing.lambda > PROFILE_WEIGHTS.planning.lambda,
];

const allPassed = roleAssertions.every(Boolean);
console.log(allPassed ? "PASS role policy" : "FAIL role policy");
process.exit(failed || !allPassed ? 1 : 0);
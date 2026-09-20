import { PROFILE_MODELS, ROLE_THINKING, resolveWorkKind } from "../src/selector.ts";

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

const paretoModels = PROFILE_MODELS.pareto_code;
const empiricalModels = PROFILE_MODELS.empirical_cost;

const roleAssertions = [
  paretoModels.planning === "anthropic/claude-sonnet-5",
  paretoModels.code === "openrouter/pareto-code",
  paretoModels.writing === "openai/gpt-5.4-mini",
  empiricalModels.code === "anthropic/claude-sonnet-5",
  ROLE_THINKING.planning === "high",
  ROLE_THINKING.code === "medium",
  ROLE_THINKING.writing === "low",
];

const allPassed = roleAssertions.every(Boolean);
console.log(allPassed ? "PASS role policy" : "FAIL role policy");
process.exit(failed || !allPassed ? 1 : 0);

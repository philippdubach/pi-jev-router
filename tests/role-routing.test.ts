import { ROLE_MODELS, ROLE_THINKING, resolveWorkKind } from "../src/selector.ts";

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

const roleAssertions = [
  ROLE_MODELS.planning === "anthropic/claude-fable-5.1",
  ROLE_THINKING.planning === "high",
  ROLE_MODELS.code === "openrouter/pareto-code",
  ROLE_THINKING.code === "high",
  ROLE_MODELS.writing === "openai/gpt-5.4-mini",
  ROLE_THINKING.writing === "low",
];
console.log(roleAssertions.every(Boolean) ? "PASS role policy" : "FAIL role policy");
process.exit(failed || !roleAssertions.every(Boolean) ? 1 : 0);

// Deterministic selector fixtures — run: node --experimental-strip-types tests/selector.test.ts
import { DEFAULT_POLICY, recommend } from "../src/selector.ts";

const a = (complexity: number, risk: number, confidence = 0.9) => ({
  complexity: { type: "score", value: complexity, confidence },
  risk: { type: "score", value: risk },
});

const cases: Array<[any, string, number]> = [
  [a(0.3, 0.5), "tier_by_complexity", 0],
  [a(1.2, 1.0), "tier_by_complexity", 1],
  [a(2.8, 1.0), "tier_by_complexity", 2],
  [a(0.3, 2.5), "risk_floor", 1],          // low complexity but high risk -> floor
  [{}, "fallback", 2],                      // classifier unavailable
];

let failed = 0;
for (const [answers, reason, tier] of cases) {
  const available = Object.keys(answers).length > 0;
  const r = recommend(answers as any, DEFAULT_POLICY, available);
  const ok = r.reason === reason && r.tierIndex === tier;
  if (!ok) failed++;
  console.log(ok ? "PASS" : "FAIL", JSON.stringify(r));
}
process.exit(failed ? 1 : 0);
// Session state — run: node --experimental-strip-types tests/session-state.test.ts
import { assistantCost, shouldReload } from "../src/session-state.ts";

let failed = 0;
const check = (name: string, ok: boolean) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) failed++; };

check("assistant cost is read", assistantCost({ role: "assistant", usage: { cost: { total: 0.0123 } } }) === 0.0123);
check("user message costs nothing", assistantCost({ role: "user", usage: { cost: { total: 5 } } }) === 0);
check("missing usage costs nothing", assistantCost({ role: "assistant" }) === 0);
check("negative or NaN costs nothing", assistantCost({ role: "assistant", usage: { cost: { total: -1 } } }) === 0
  && assistantCost({ role: "assistant", usage: { cost: { total: "x" } } }) === 0);

const loaded = { at: 1_000, resultsMtimeMs: 500 };
check("fresh and unchanged: keep", !shouldReload(loaded, 2_000, 500, 10_000));
check("older than the TTL: reload", shouldReload(loaded, 20_000, 500, 10_000));
check("new result file: reload", shouldReload(loaded, 2_000, 900, 10_000));
process.exit(failed ? 1 : 0);

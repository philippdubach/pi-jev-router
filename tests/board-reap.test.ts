// Stale-lease reaping — run: node --experimental-strip-types tests/board-reap.test.ts
import "./_isolate.ts";
import { createTask, transition, getTask, reapStale, LEASE_TIMEOUT_MS } from "../src/board.ts";
let failed = 0;
function check(name: string, cond: boolean, detail = "") { console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail); if (!cond) failed++; }

const fresh = createTask("reap test: fresh verifying");
transition(fresh.id, null, "verifying");
const stale = createTask("reap test: stale verifying");
transition(stale.id, null, "verifying");
const now = Date.now();

const early = reapStale(now);
check("nothing reaped before the lease lapses", !early.includes(fresh.id) && !early.includes(stale.id), JSON.stringify(early));
const later = now + LEASE_TIMEOUT_MS + 60_000;
const reaped = reapStale(later);
check("stale task is reaped after the lease", reaped.includes(stale.id) && reaped.includes(fresh.id));
check("reaped task is blocked with a reason", getTask(stale.id)?.status === "blocked" && (getTask(stale.id)?.verification ?? "").includes("lease expired"));
check("reaping is idempotent", reapStale(later).length === 0);
// clean up
transition(fresh.id, "blocked", "cancelled"); transition(stale.id, "blocked", "cancelled");
process.exit(failed ? 1 : 0);

// Isolation — run: node --experimental-strip-types tests/isolation.test.ts
// Run directly, without npm test's PI_JEV_ROUTER_DIR, to prove the guard works.
import { TEST_DIR } from "./_isolate.ts";
import { ROUTER_DIR } from "../src/paths.ts";
import { homedir } from "node:os";
import { join } from "node:path";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed++;
};
check("router dir is the test dir", ROUTER_DIR === TEST_DIR, `${ROUTER_DIR} vs ${TEST_DIR}`);
check("router dir is not the real one", ROUTER_DIR !== join(homedir(), ".pi", "agent", "jev-router"));
process.exit(failed ? 1 : 0);

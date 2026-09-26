// Dispatch outcome — run: node --experimental-strip-types tests/dispatch-outcome.test.ts
import "./_isolate.ts";
import { dispatchOutcome } from "../src/dispatch.ts";

let failed = 0;
const check = (name: string, ok: boolean) => { console.log(ok ? "PASS" : "FAIL", name); if (!ok) failed++; };
const s = (workerOk: boolean, handshake: boolean, hasVerifier: boolean, verifiedPass: boolean) =>
  dispatchOutcome({ workerOk, handshake, hasVerifier, verifiedPass });

check("verifier passed", s(true, true, true, true) === "verified_pass");
check("verifier failed", s(true, true, true, false) === "verifier_failed");
check("worker crashed", s(false, false, true, false) === "worker_error");
check("no handshake", s(true, false, false, false) === "handshake_missing");
check("done without a verifier", s(true, true, false, false) === "no_verifier");
process.exit(failed ? 1 : 0);

// Pass-rate posterior fixtures — run: node --experimental-strip-types tests/posterior.test.ts
import { posteriorQuality, EVIDENCE_PSEUDO_COUNT } from "../src/selector.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail);
  if (!cond) failed++;
}

const prior = 0.872;

check("no runs keeps the prior", posteriorQuality(0, 0, prior) === prior);
check("negative runs keeps the prior", posteriorQuality(0, -3, prior) === prior);

const clean3 = posteriorQuality(3, 3, prior);
check("a clean record raises quality", clean3 > prior, `${clean3} vs ${prior}`);

const clean50 = posteriorQuality(50, 50, prior);
check("more clean runs raise it further", clean50 > clean3);
check("a perfect record approaches 1", clean50 > 0.99, String(clean50));

const failed3 = posteriorQuality(0, 3, prior);
check("total failure drops well below prior", failed3 < prior - 0.4, String(failed3));
check("failure outweighs an equal clean record", prior - failed3 > clean3 - prior);

const half = posteriorQuality(5, 10, prior);
check("a mixed record lands between", half > failed3 && half < prior, String(half));

check("stays inside [0,1]", [posteriorQuality(0, 1, 0), posteriorQuality(1, 1, 1)].every((v) => v >= 0 && v <= 1));
check("clamps passes above runs", posteriorQuality(99, 3, prior) <= 1);

// A weak model with a clean record must not overtake a strong model with the
// same record: the prior still carries the difference.
const weak = posteriorQuality(3, 3, 0.4);
check("prior still separates equal records", clean3 > weak, `${clean3} vs ${weak}`);

// Regression: the old rule smoothed toward 0.5 and capped a clean 3-run
// record at 0.8, scoring a strong model below its own prior.
const oldRule = (p: number, r: number, pr: number) => {
  const w = r / (r + 5);
  return w * ((p + 1) / (r + 2)) + (1 - w) * pr;
};
check("old rule penalised a clean record", oldRule(3, 3, prior) < prior);
check("new rule does not", posteriorQuality(3, 3, prior) > prior);

check("pseudo-count is exported", EVIDENCE_PSEUDO_COUNT === 2);

process.exit(failed ? 1 : 0);

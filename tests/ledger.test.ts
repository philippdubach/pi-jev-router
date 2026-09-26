// Ledger — run: node --experimental-strip-types tests/ledger.test.ts
import { TEST_DIR } from "./_isolate.ts";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { record, LEDGER_FILE } from "../src/ledger.ts";
import { LOADED_VERSION, readVersion } from "../src/version.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed++;
};

check("ledger lives in the test dir", LEDGER_FILE.startsWith(TEST_DIR));
record({ taskId: "t-1", mode: "shadow", recommendation: { modelId: "z-ai/glm-5.3-flash" }, activeModel: "anthropic/claude-fable-5-1", contextTokens: 42000 });
const row = JSON.parse(readFileSync(LEDGER_FILE, "utf8").trim().split("\n").pop()!);
check("row carries the loaded version", row.routerVersion === LOADED_VERSION && LOADED_VERSION.length > 0, row.routerVersion);
check("pick and active model are kept apart", row.recommendation.modelId === "z-ai/glm-5.3-flash" && row.activeModel === "anthropic/claude-fable-5-1");
check("context tokens recorded", row.contextTokens === 42000);

const bare = mkdtempSync(join(tmpdir(), "ver-"));
writeFileSync(join(bare, "package.json"), JSON.stringify({ version: "9.9.9" }));
check("non-git dir falls back to package version", readVersion(bare) === "v9.9.9", readVersion(bare));
check("git checkout gives a short sha", /^[0-9a-f]{7,}$/.test(readVersion()), readVersion());

// Ledger write failure must not throw — record() silently fails to stderr.
try {
  rmSync(LEDGER_FILE, { force: true, recursive: true });
  mkdirSync(LEDGER_FILE);
  let threw = false;
  try {
    record({ taskId: "t-blocked", mode: "auto", recommendation: {} });
  } catch {
    threw = true;
  }
  check("ledger write failure does not throw", !threw);
  rmSync(LEDGER_FILE, { recursive: true });
} catch (e) {
  check("ledger write failure does not throw", false, String(e));
}

process.exit(failed ? 1 : 0);

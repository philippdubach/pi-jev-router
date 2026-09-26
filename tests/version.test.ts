// Version status line — run: node --experimental-strip-types tests/version.test.ts
import { versionLine } from "../src/version.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed++;
};

check("loaded and disk versions match", versionLine("abc1234", "abc1234") === "version: abc1234");
check(
  "disk version differs: says so and names both",
  versionLine("abc1234", "def5678") === "version: abc1234 loaded, def5678 on disk — restart pi to load it",
);

process.exit(failed ? 1 : 0);

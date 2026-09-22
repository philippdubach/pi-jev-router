/**
 * Verification against tests the model never sees.
 *
 * The visible suite is deliberately partial. A model can satisfy it by
 * special-casing the cases in front of it, which is exactly the behaviour the
 * earlier code tasks failed to separate. The hidden suite checks the rest of
 * the behaviour stated in the prompt, so passing requires implementing the
 * spec rather than the fixture.
 *
 * Both suites run. The visible one must pass first: if it fails, the hidden
 * result is not informative.
 */
import { execFile } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HIDDEN_FILE = "hidden.spec.ts";

export interface VerifyResult { ok: boolean; message: string }

async function runNode(file: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await execFileP("node", ["--experimental-strip-types", file], { cwd, timeout: timeoutMs });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (err: any) {
    const out = String(err?.stdout || "") + String(err?.stderr || err?.message || "");
    return { ok: false, out: out.replace(/\s+/g, " ").trim() };
  }
}

/** Pull the most useful line out of a failed run. */
function firstFailure(out: string): string {
  // Prefer the thrown message. A bare `Assertion failed:` also matches the
  // source line of the assert helper echoed in the stack frame.
  const thrown = out.match(/Error: Assertion failed: [^\n]{0,160}/);
  if (thrown) return thrown[0].replace(/^Error: /, "");
  const assertion = out.match(/Assertion failed: (?!" \+ m)[^\n]{0,160}/);
  if (assertion) return assertion[0];
  const error = out.match(/\b(\w*Error): [^\n]{0,140}/);
  if (error) return error[0];
  return out.slice(0, 160) || "no output";
}

export function hiddenVerifier(hiddenSource: string, timeoutMs = 90_000) {
  return async function verify(workspaceDir: string): Promise<VerifyResult> {
    const visible = await runNode("test.ts", workspaceDir, timeoutMs);
    if (!visible.ok) {
      return { ok: false, message: `Visible tests failed: ${firstFailure(visible.out)}` };
    }

    const hiddenPath = join(workspaceDir, HIDDEN_FILE);
    try {
      writeFileSync(hiddenPath, hiddenSource);
      const hidden = await runNode(HIDDEN_FILE, workspaceDir, timeoutMs);
      if (!hidden.ok) {
        return { ok: false, message: `Visible tests passed, hidden tests failed: ${firstFailure(hidden.out)}` };
      }
      return { ok: true, message: `Visible and hidden tests passed. ${hidden.out.slice(0, 100)}` };
    } finally {
      // Leave no trace that could be picked up by a later run in the same tree.
      rmSync(hiddenPath, { force: true });
    }
  };
}

/**
 * Dispatch: start an isolated pi worker for a board task (M3.0).
 *
 * - Routes the worker through the Jev classifier + tier policy before spawn.
 * - Writes a durable brief file; the worker prompt points at it (short prompt,
 *   durable channel — per the Chief of Staff discipline).
 * - Spawns `pi --mode json -p` with an explicit model, a task-owned session
 *   dir, a worker-role system prompt, and no third-party extension loading.
 * - Requires a startup handshake: the worker must emit its task id and nonce.
 * - One worker at a time (M3.0); git-worktree isolation arrives in M3.1.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { classify, WRITING_STYLE_DIRECTIVE } from "./classifier.ts";
import { selectModel, resolveWorkKind, ROLE_THINKING } from "./selector.ts";
import { loadCatalog } from "./catalog.ts";
import { loadEvidence } from "./evidence.ts";
import { transition, logEvent, getTask } from "./board.ts";
import type { TaskEnvelope, ClassificationResult } from "./task-envelope.ts";

import { createWorktree, cleanupWorktree, mergeWorktree, type WorktreeSession } from "./worktree.ts";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const TASK_DIR_ROOT = join(homedir(), ".pi", "agent", "jev-router", "tasks");

export interface DispatchOptions {
  cwd: string;
  acceptanceCriteria?: string[];
  verifierCommand?: string;
  isolateWorktree?: boolean;
  role?: string; // "planning" | "code" | "writing" — else classified
  signal?: AbortSignal;
  onLine?: (evt: any) => void;
}

export interface DispatchResult {
  ok: boolean;
  taskId: string;
  model: string;
  thinking: string;
  handshake: boolean;
  finalOutput: string;
  verificationOutput?: string;
  worktreeIsolated?: boolean;
  usage: { input: number; output: number; cost: number; turns: number };
  error?: string;
}

const WORKER_SYSTEM_PROMPT = `You are a task worker in an orchestrated run.
Read the brief file you were given and do exactly what it says.
Constraints:
- Work only toward the brief's objective and acceptance criteria.
- Do not commit, push, or modify files outside the brief's scope.
- When finished, write a machine-readable summary to the result file you were given:
  {"taskId":"<id>","nonce":"<nonce>","status":"done|failed|blocked","summary":"<what was done>","verification":"<commands you ran and their exit codes>"}
- Report exit codes honestly. A summary is intent, not evidence.`;

export function writeBrief(taskId: string, objective: string, acceptance: string[], cwd: string): string {
  const dir = join(TASK_DIR_ROOT, taskId);
  mkdirSync(dir, { recursive: true });
  const brief = [
    `# Task ${taskId}`,
    "",
    "## Objective",
    objective,
    "",
    "## Acceptance criteria",
    ...(acceptance.length ? acceptance.map((a) => `- ${a}`) : ["- Complete the objective as stated"]),
    "",
    `## Working directory: ${cwd}`,
    "",
    "## Non-goals",
    "- Anything not stated in the objective",
    "- Committing, pushing or deploying",
    "",
    "## Handoff",
    "Write your final summary to summary.json in this task directory when done.",
  ].join("\n");
  const briefPath = join(dir, "brief.md");
  writeFileSync(briefPath, brief);
  return briefPath;
}

/** Classify the task and pick model+thinking. Falls back to static policy. */
export async function routeTask(objective: string, cwd: string, explicitRole?: string) {
  const envelope: TaskEnvelope = {
    taskId: `r-${randomUUID().slice(0, 8)}`,
    role: (explicitRole as TaskEnvelope["role"]) ?? "implementer",
    objective,
    acceptanceCriteria: [],
    relevantContext: "",
    facts: { hasImages: false, estimatedContextTokens: Math.ceil(objective.length / 4), requiredTools: [], attempt: 0, priorFailureKinds: [] },
    policyRef: "policy@v2",
  };
  const c = await classify(envelope);
  const category = String((c.answers as any).category?.value ?? "");
  const workKind = resolveWorkKind(explicitRole, category, objective);
  const { models } = await loadCatalog();
  const evidence = loadEvidence();
  const r = selectModel(envelope, c, models, evidence, "frontier", workKind);
  const thinking = ROLE_THINKING[workKind];
  return { recommendation: r, thinking, classification: c, workKind };
}

export async function dispatch(taskId: string, opts: DispatchOptions): Promise<DispatchResult> {
  const task = getTask(taskId);
  if (!task) return { ok: false, taskId, model: "", thinking: "", handshake: false, finalOutput: "", usage: { input: 0, output: 0, cost: 0, turns: 0 }, error: "unknown task" };

  // Set up isolated worktree if in a git repo and isolation is not disabled
  let targetCwd = opts.cwd;
  let worktreeSession: WorktreeSession | null = null;
  if (opts.isolateWorktree !== false) {
    worktreeSession = await createWorktree(opts.cwd, taskId);
    if (worktreeSession) {
      targetCwd = worktreeSession.worktreePath;
    }
  }

  const { recommendation, thinking, classification, workKind } = await routeTask(task.objective, targetCwd, opts.role);
  const briefPath = writeBrief(taskId, task.objective, opts.acceptanceCriteria ?? [], targetCwd);
  const nonce = randomUUID().slice(0, 8);
  const summaryPath = join(TASK_DIR_ROOT, taskId, "summary.json");

  if (!transition(taskId, null, "running", { model: recommendation.modelId, thinking, briefPath, leaseNonce: nonce, attempt: task.attempt + 1 })) {
    if (worktreeSession) await cleanupWorktree(worktreeSession);
    return { ok: false, taskId, model: recommendation.modelId, thinking, handshake: false, finalOutput: "", usage: { input: 0, output: 0, cost: 0, turns: 0 }, error: "transition to running failed" };
  }
  logEvent(taskId, "routed", { model: recommendation.modelId, thinking, classifier: classification.resolvedModel, worktree: !!worktreeSession });

  const workerPrompt = `Read ${briefPath} and do exactly what it says. When finished, write ${summaryPath} containing {"taskId":"${taskId}","nonce":"${nonce}","status":"done|failed|blocked","summary":"...","verification":"..."}`;

  // Writing tasks get the humanizer + STE style directive.
  const systemPrompt = workKind === "writing" ? WORKER_SYSTEM_PROMPT + WRITING_STYLE_DIRECTIVE : WORKER_SYSTEM_PROMPT;
  const args = [
    "--mode", "json", "-p",
    "--session-dir", join(TASK_DIR_ROOT, taskId, "session"),
    "--provider", "openrouter", "--model", recommendation.modelId,
    "--thinking", thinking,
    "--no-extensions",
    "--no-context-files",
    "--append-system-prompt", systemPrompt,
    workerPrompt,
  ];

  const result = await runPi(args, { ...opts, cwd: targetCwd });
  const handshake = checkHandshake(taskId, nonce, summaryPath);

  let verifiedPass = false;
  let verificationOutput: string | undefined;

  // Automated Verification (if verifierCommand is specified)
  if (result.ok && handshake && opts.verifierCommand) {
    try {
      const { stdout, stderr } = await execAsync(opts.verifierCommand, { cwd: targetCwd, timeout: 60000 });
      verifiedPass = true;
      verificationOutput = `PASS (${opts.verifierCommand}): ${(stdout || stderr).slice(0, 500)}`;
      
      // Verification passed -> merge isolated worktree into main repo
      if (worktreeSession) {
        const mergeRes = await mergeWorktree(worktreeSession);
        if (!mergeRes.ok) {
          verificationOutput += ` (Merge warning: ${mergeRes.error})`;
        }
        await cleanupWorktree(worktreeSession);
      }
      transition(taskId, "running", "done", { resultSummary: result.finalOutput.slice(0, 2000), verification: verificationOutput });
    } catch (err: any) {
      verifiedPass = false;
      const code = err?.code ?? err?.signal ?? "?";
      verificationOutput = `FAIL (${opts.verifierCommand}) exit=${code}: ${String(err.stdout || err.stderr || err.message).slice(0, 500)}`;
      
      // Verification failed -> clean up worktree without dirtying main repo!
      if (worktreeSession) {
        await cleanupWorktree(worktreeSession);
      }
      transition(taskId, "running", "failed", { resultSummary: result.finalOutput.slice(0, 2000), verification: verificationOutput });
    }
  } else if (result.ok && handshake) {
    // No verifierCommand -> park in verifying for manual /chief verify
    transition(taskId, "running", "verifying", { resultSummary: result.finalOutput.slice(0, 2000) });
  } else {
    // Worker failed or handshake missing -> cleanup worktree
    if (worktreeSession) await cleanupWorktree(worktreeSession);
    transition(taskId, "running", result.ok ? "blocked" : "failed", { resultSummary: result.finalOutput.slice(0, 2000) });
  }

  const isSuccess = opts.verifierCommand ? verifiedPass : (result.ok && handshake);

  return {
    ok: isSuccess,
    taskId,
    model: recommendation.modelId,
    thinking,
    handshake,
    finalOutput: result.finalOutput,
    verificationOutput,
    worktreeIsolated: !!worktreeSession,
    usage: result.usage,
    error: result.error ?? (!handshake ? "worker did not produce a valid summary.json handshake" : (opts.verifierCommand && !verifiedPass ? "verification command failed" : undefined)),
  };
}

function checkHandshake(taskId: string, nonce: string, summaryPath: string): boolean {
  if (!existsSync(summaryPath)) return false;
  try {
    const s = JSON.parse(readFileSync(summaryPath, "utf8"));
    return s.taskId === taskId && s.nonce === nonce && ["done", "failed", "blocked"].includes(s.status);
  } catch {
    return false;
  }
}

function runPi(args: string[], opts: { cwd: string; signal?: AbortSignal; onLine?: (e: any) => void }): Promise<{ ok: boolean; finalOutput: string; usage: DispatchResult["usage"]; error?: string }> {
  return new Promise((resolve) => {
    const usage = { input: 0, output: 0, cost: 0, turns: 0 };
    let finalOutput = "";
    const proc = spawn("pi", args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const handle = (line: string) => {
      if (!line.trim()) return;
      let e: any; try { e = JSON.parse(line); } catch { return; }
      opts.onLine?.(e);
      if (e.type === "message_end" && e.message?.role === "assistant") {
        usage.turns++;
        usage.input += e.message.usage?.input ?? 0;
        usage.output += e.message.usage?.output ?? 0;
        usage.cost += e.message.usage?.cost?.total ?? 0;
        const text = (e.message.content ?? []).find((c: any) => c.type === "text")?.text;
        if (text) finalOutput = text;
      }
    };
    proc.stdout.on("data", (d) => { buf += d.toString(); const lines = buf.split("\n"); buf = lines.pop() ?? ""; lines.forEach(handle); });
    proc.stderr.on("data", () => {});
    proc.on("close", (code) => { if (buf.trim()) handle(buf); resolve({ ok: code === 0, finalOutput, usage }); });
    proc.on("error", (err) => resolve({ ok: false, finalOutput: "", usage, error: String(err) }));
    if (opts.signal) {
      const kill = () => proc.kill("SIGTERM");
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", kill, { once: true });
    }
  });
}

export { dispatch as dispatchTask };

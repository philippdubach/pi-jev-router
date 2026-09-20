import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { BENCHMARK_TASKS } from "./tasks.ts";
import type { BenchmarkTask, RoutingStrategy, TaskRunResult, StrategySummary } from "./types.ts";
import { verifyCommand } from "./verifiers.ts";
import { classify, WRITING_STYLE_DIRECTIVE } from "../src/classifier.ts";
import { DEFAULT_POLICY, recommend, recommendByRole, resolveWorkKind, ROLE_MODELS, ROLE_THINKING } from "../src/selector.ts";
import type { TaskEnvelope } from "../src/task-envelope.ts";

function getOpenRouterKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
    return auth?.openrouter?.access || auth?.openrouter?.key;
  } catch {
    return undefined;
  }
}

async function fetchGenerationCost(responseId: string): Promise<number> {
  const key = getOpenRouterKey();
  if (!key) return 0;
  try {
    const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${responseId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return 0;
    const json: any = await res.json();
    return Number(json?.data?.total_cost) || Number(json?.data?.usage) || 0;
  } catch {
    return 0;
  }
}

const RUN_ID = `bench-${Date.now().toString(36)}`;
const BASE_EVAL_DIR = join(tmpdir(), "pi-jev-benchmarks", RUN_ID);

interface ModelSelection {
  model: string;
  thinking: string;
  systemPromptAppend?: string;
  reason: string;
}

async function resolveModelForStrategy(
  strategy: RoutingStrategy,
  task: BenchmarkTask
): Promise<ModelSelection> {
  if (strategy === "fixed_frontier") {
    return {
      model: "anthropic/claude-sonnet-5",
      thinking: "high",
      reason: "fixed_frontier_baseline",
    };
  }

  // Build task envelope for classification
  const envelope: TaskEnvelope = {
    taskId: task.id,
    role: "direct",
    objective: task.prompt,
    acceptanceCriteria: [],
    relevantContext: "",
    facts: {
      hasImages: false,
      estimatedContextTokens: Math.ceil(task.prompt.length / 4),
      requiredTools: ["read", "write", "edit", "bash"],
      attempt: 0,
      priorFailureKinds: [],
    },
    policyRef: "policy@v1",
  };

  const classification = await classify(envelope);
  const category = String((classification.answers as any)?.category?.value ?? "");
  const workKind = resolveWorkKind(undefined, category, task.prompt);

  if (strategy === "router_role") {
    const recommendation = recommendByRole(workKind, classification.answers as any, DEFAULT_POLICY, !classification.classifierUnavailable);
    const thinking = workKind === "other"
      ? (recommendation.tierIndex === 0 ? "low" : recommendation.tierIndex === 1 ? "medium" : "high")
      : ROLE_THINKING[workKind];

    return {
      model: recommendation.modelId,
      thinking,
      systemPromptAppend: workKind === "writing" ? WRITING_STYLE_DIRECTIVE : undefined,
      reason: `role:${workKind}`,
    };
  }

  // strategy === "router_tiered"
  const recommendation = recommend(classification.answers as any, DEFAULT_POLICY, !classification.classifierUnavailable);
  const thinking = recommendation.tierIndex === 0 ? "low" : recommendation.tierIndex === 1 ? "medium" : "high";
  return {
    model: recommendation.modelId,
    thinking,
    reason: `tier:${recommendation.tierIndex} (${recommendation.reason})`,
  };
}

async function runSession(
  workspaceDir: string,
  modelSelection: ModelSelection,
  prompt: string,
  timeoutMs = 180000
): Promise<{
  ok: boolean;
  tokens: TaskRunResult["tokens"];
  costUsd: number;
  turns: number;
  latencyMs: number;
  output: string;
  error?: string;
}> {
  const sessionDir = join(workspaceDir, ".session");
  mkdirSync(sessionDir, { recursive: true });

  const args = [
    "--mode", "json", "-p",
    "--session-dir", sessionDir,
    "--provider", "openrouter",
    "--model", modelSelection.model,
    "--thinking", modelSelection.thinking,
    "--no-extensions",
    "--no-context-files",
  ];

  if (modelSelection.systemPromptAppend) {
    args.push("--append-system-prompt", modelSelection.systemPromptAppend);
  }

  args.push(prompt);

  const start = Date.now();
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let costUsd = 0;
  let turns = 0;
  let finalOutput = "";
  const responseIds: string[] = [];

  return new Promise((resolve) => {
    const proc = spawn("pi", args, {
      cwd: workspaceDir,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        ok: false,
        tokens,
        costUsd,
        turns,
        latencyMs: Date.now() - start,
        output: finalOutput,
        error: "Execution timed out",
      });
    }, timeoutMs);

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === "message_end" && event.message?.role === "assistant") {
        turns++;
        if (event.message.responseId) {
          responseIds.push(event.message.responseId);
        }
        const u = event.message.usage;
        if (u) {
          tokens.input += u.input || 0;
          tokens.output += u.output || 0;
          tokens.cacheRead += u.cacheRead || 0;
          tokens.cacheWrite += u.cacheWrite || 0;
          tokens.total += u.totalTokens || (u.input + u.output);
          costUsd += u.cost?.total || 0;
        }
        const textParts = (event.message.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text);
        if (textParts.length) finalOutput = textParts.join("\n");
      }
    };

    proc.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
    });

    proc.on("close", async (code) => {
      clearTimeout(timer);
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer);

      // Reconcile exact OpenRouter cost if local catalogue cost was 0 (router models)
      if (costUsd === 0 && responseIds.length > 0) {
        let reconciled = 0;
        for (const id of responseIds) {
          reconciled += await fetchGenerationCost(id);
        }
        if (reconciled > 0) costUsd = reconciled;
      }

      resolve({
        ok: code === 0,
        tokens,
        costUsd,
        turns,
        latencyMs: Date.now() - start,
        output: finalOutput,
        error: code === 0 ? undefined : `Process exited with code ${code}. Stderr: ${stderrBuffer.slice(0, 300)}`,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        tokens,
        costUsd,
        turns,
        latencyMs: Date.now() - start,
        output: finalOutput,
        error: String(err),
      });
    });
  });
}

export async function runTaskForStrategy(
  task: BenchmarkTask,
  strategy: RoutingStrategy
): Promise<TaskRunResult> {
  const workspaceDir = join(BASE_EVAL_DIR, strategy, task.id);
  mkdirSync(workspaceDir, { recursive: true });

  // 1. Setup workspace files
  if (task.setupFiles) {
    for (const [filename, content] of Object.entries(task.setupFiles)) {
      writeFileSync(join(workspaceDir, filename), content, "utf8");
    }
  }

  // 2. Resolve model via strategy
  const selection = await resolveModelForStrategy(strategy, task);
  console.log(`   [${strategy}] Task: ${task.id} -> Model: ${selection.model} (${selection.thinking}) [${selection.reason}]`);

  // 3. Dispatch separate session
  const run = await runSession(workspaceDir, selection, task.prompt);

  // 4. Verify independently
  let passed = false;
  let verifierOutput = "";

  if (task.verifierCommand) {
    const v = await verifyCommand(task.verifierCommand, workspaceDir);
    passed = v.ok;
    verifierOutput = v.message;
  } else if (task.customVerifier) {
    const v = await task.customVerifier(workspaceDir);
    passed = v.ok;
    verifierOutput = v.message;
  } else {
    passed = run.ok;
    verifierOutput = "No verifier configured; using process exit code.";
  }

  return {
    taskId: task.id,
    strategy,
    modelUsed: selection.model,
    thinkingUsed: selection.thinking,
    passed,
    verifierOutput,
    latencyMs: run.latencyMs,
    tokens: run.tokens,
    costUsd: run.costUsd,
    turns: run.turns,
    error: run.error,
  };
}

export function summarizeStrategy(strategy: RoutingStrategy, results: TaskRunResult[]): StrategySummary {
  const matching = results.filter((r) => r.strategy === strategy);
  const totalTasks = matching.length;
  const passedTasks = matching.filter((r) => r.passed).length;
  const passRate = totalTasks > 0 ? (passedTasks / totalTasks) * 100 : 0;
  const totalCostUsd = matching.reduce((sum, r) => sum + r.costUsd, 0);
  const costPerSuccessUsd = passedTasks > 0 ? totalCostUsd / passedTasks : totalCostUsd;
  const avgLatencyMs = totalTasks > 0 ? matching.reduce((sum, r) => sum + r.latencyMs, 0) / totalTasks : 0;
  const totalTokens = matching.reduce((sum, r) => sum + r.tokens.total, 0);

  return {
    strategy,
    totalTasks,
    passedTasks,
    passRate,
    totalCostUsd,
    costPerSuccessUsd,
    avgLatencyMs,
    totalTokens,
  };
}

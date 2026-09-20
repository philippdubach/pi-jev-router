import { exec } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export async function verifyCommand(
  cmd: string,
  cwd: string,
  timeoutMs = 60000
): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: timeoutMs });
    return {
      ok: true,
      message: `Command passed: ${stdout.slice(0, 500)}${stderr ? "\nstderr: " + stderr.slice(0, 300) : ""}`,
    };
  } catch (err: any) {
    const code = err.code ?? err.signal ?? "?";
    return {
      ok: false,
      message: `Command failed (exit ${code}):\n${(err.stdout || "").slice(0, 500)}\n${(err.stderr || "").slice(0, 500)}`,
    };
  }
}

const BANNED_AI_WORDS = [
  "delve",
  "delves",
  "delving",
  "testament",
  "tapestry",
  "furthermore",
  "moreover",
  "in conclusion",
  "in summary",
  "not only",
  "pivotal",
  "crucial",
  "beacon",
  "revolutionize",
  "foster",
  "embark",
  "underscores",
  "bustling",
  "meticulous",
];

export async function verifyWritingSTE(workspaceDir: string): Promise<{ ok: boolean; message: string }> {
  const possiblePaths = [
    join(workspaceDir, "postmortem.md"),
    join(workspaceDir, "incident-postmortem.md"),
    join(workspaceDir, "output.md"),
  ];
  const target = possiblePaths.find((p) => existsSync(p));
  if (!target) {
    return { ok: false, message: `Output file not found. Checked: ${possiblePaths.join(", ")}` };
  }

  const content = readFileSync(target, "utf8");
  if (content.trim().length < 200) {
    return { ok: false, message: "Output file is too short (< 200 characters)." };
  }

  const errors: string[] = [];

  // 1. Required sections
  const requiredSections = ["summary", "impact", "timeline", "root cause", "action"];
  const lowerContent = content.toLowerCase();
  for (const sec of requiredSections) {
    if (!lowerContent.includes(sec)) {
      errors.push(`Missing required section keyword: '${sec}'`);
    }
  }

  // 2. Banned AI tropes
  for (const banned of BANNED_AI_WORDS) {
    const regex = new RegExp(`\\b${banned}\\b`, "i");
    if (regex.test(content)) {
      errors.push(`Contains banned AI filler word: '${banned}'`);
    }
  }

  // 3. Simplified Technical English sentence length rule
  // Sentences should be short (under 25 words each)
  const sentences = content
    .replace(/[#*`_\[\]]/g, "") // strip markdown
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);

  let longSentences = 0;
  for (const sentence of sentences) {
    const wordCount = sentence.split(/\s+/).length;
    if (wordCount > 25) {
      longSentences++;
    }
  }

  const longSentenceRatio = sentences.length > 0 ? longSentences / sentences.length : 0;
  if (longSentenceRatio > 0.2) {
    errors.push(`STE sentence length violation: ${(longSentenceRatio * 100).toFixed(0)}% of sentences exceed 25 words (max allowed: 20%).`);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      message: `Writing verification failed:\n- ${errors.join("\n- ")}`,
    };
  }

  return {
    ok: true,
    message: `STE & Humanizer verification passed (${sentences.length} sentences checked, clean of AI tropes).`,
  };
}

export async function verifyPlanningArchitecture(workspaceDir: string): Promise<{ ok: boolean; message: string }> {
  const possiblePaths = [
    join(workspaceDir, "plan.md"),
    join(workspaceDir, "architecture.md"),
    join(workspaceDir, "rate-limiter.md"),
    join(workspaceDir, "output.md"),
  ];
  const target = possiblePaths.find((p) => existsSync(p));
  if (!target) {
    return { ok: false, message: `Output file not found. Checked: ${possiblePaths.join(", ")}` };
  }

  const content = readFileSync(target, "utf8");
  if (content.trim().length < 400) {
    return { ok: false, message: "Architecture plan is too short (< 400 characters)." };
  }

  const errors: string[] = [];
  const lower = content.toLowerCase();

  // Architectural components
  if (!lower.includes("redis") && !lower.includes("token bucket") && !lower.includes("sliding window")) {
    errors.push("Missing core rate limiter mechanism (Redis / Token bucket / Sliding window).");
  }

  // Atomicity / Concurrency
  if (!lower.includes("lua") && !lower.includes("atomic") && !lower.includes("pipeline") && !lower.includes("multi/exec")) {
    errors.push("Missing atomic concurrency control mechanism (Lua script or atomic Redis operations).");
  }

  // Failure modes / Outage mitigation
  if (!lower.includes("outage") && !lower.includes("degrad") && !lower.includes("failover") && !lower.includes("fallback")) {
    errors.push("Missing Redis outage / failure mode fallback strategy.");
  }

  // Rollback criteria / Triggers
  if (!lower.includes("rollback") && !lower.includes("trigger") && !lower.includes("threshold")) {
    errors.push("Missing concrete rollback criteria or triggers.");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      message: `Planning verification failed:\n- ${errors.join("\n- ")}`,
    };
  }

  return {
    ok: true,
    message: "Planning architecture verification passed (includes atomicity, outage fallback, and rollback triggers).",
  };
}

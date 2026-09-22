/**
 * Task context collection.
 *
 * The classifier can only judge what it can see. Earlier versions sent the raw
 * prompt and nothing else, which produced `category: unclear` on half of all
 * requests and `brief: clarify` on most of them.
 *
 * This module gathers bounded, decision-relevant signals from the session and
 * the repository. Every field is capped: Jev loses accuracy when the state
 * carries material the question does not need, so this collects little and
 * keeps it short rather than dumping history.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { TaskFacts } from "./task-envelope.ts";

const execFileP = promisify(execFile);

/** Hard caps. These bound what reaches the classifier. */
export const MAX_RECENT_TURNS = 3;
export const MAX_TURN_CHARS = 180;
export const MAX_PATHS = 8;
export const MAX_TOOLS = 12;
export const MAX_CONTEXT_CHARS = 1400;
const GIT_TIMEOUT_MS = 800;

const EXT_LANGUAGE: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java", ".rb": "Ruby",
  ".php": "PHP", ".swift": "Swift", ".kt": "Kotlin", ".c": "C", ".h": "C",
  ".cpp": "C++", ".cs": "C#", ".sh": "Shell", ".sql": "SQL", ".md": "Markdown",
  ".css": "CSS", ".scss": "CSS", ".html": "HTML", ".json": "JSON", ".yml": "YAML", ".yaml": "YAML",
};

export interface RepoFacts {
  isGitRepo: boolean;
  branch?: string;
  dirtyFiles?: number;
  language?: string;
}

export interface CollectedContext {
  relevantContext: string;
  facts: TaskFacts;
  /** Kept separate so the caller can log what was observed without re-deriving it. */
  observed: {
    referencedPaths: string[];
    recentTools: string[];
    repo: RepoFacts;
    isFollowUp: boolean;
  };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Extract path-like tokens from the prompt. Pi expands `@file` references
 * before this runs, so plain path tokens are the reliable signal.
 */
export function extractPaths(prompt: string, cwd: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const candidates = prompt.match(/(?:^|[\s"'`(])(@?[\w./-]*\/[\w./-]+|[\w-]+\.[a-zA-Z]{1,5})/g) ?? [];
  for (const raw of candidates) {
    const token = raw.trim().replace(/^[@"'`(]+/, "").replace(/[),.;:'"`]+$/, "");
    if (!token || token.length < 3 || seen.has(token)) continue;
    if (/^https?:/.test(token) || token.includes("://")) continue;
    if (!token.includes("/") && !extname(token)) continue;
    seen.add(token);
    const abs = isAbsolute(token) ? token : resolve(cwd, token);
    let exists = false;
    try { exists = existsSync(abs); } catch { exists = false; }
    out.push(exists ? token : `${token} (not found)`);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

/** Dominant language among referenced paths, else undefined. */
export function inferLanguage(paths: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const lang = EXT_LANGUAGE[extname(p.replace(/ \(not found\)$/, "")).toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [lang, n] of counts) if (n > bestCount) { best = lang; bestCount = n; }
  return best;
}

export async function collectRepoFacts(cwd: string): Promise<RepoFacts> {
  try {
    const { stdout: branch } = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: GIT_TIMEOUT_MS });
    let dirtyFiles: number | undefined;
    try {
      const { stdout: status } = await execFileP("git", ["status", "--porcelain"], { cwd, timeout: GIT_TIMEOUT_MS });
      dirtyFiles = status.split("\n").filter((l) => l.trim()).length;
    } catch { /* status is optional */ }
    return { isGitRepo: true, branch: branch.trim() || undefined, dirtyFiles };
  } catch {
    return { isGitRepo: false };
  }
}

interface SessionSignals {
  recentTurns: string[];
  recentTools: string[];
  failureKinds: string[];
  attempt: number;
  isFollowUp: boolean;
}

/**
 * Walk the active branch backwards for recent user intent and tool activity.
 * Defensive throughout: session entry shapes vary by pi version, and a
 * classifier input is never worth throwing a turn for.
 */
export function readSessionSignals(sessionManager: any): SessionSignals {
  const empty: SessionSignals = { recentTurns: [], recentTools: [], failureKinds: [], attempt: 0, isFollowUp: false };
  let entries: any[];
  try {
    entries = sessionManager?.getBranch?.() ?? [];
    if (!Array.isArray(entries)) return empty;
  } catch { return empty; }

  const recentTurns: string[] = [];
  const recentTools: string[] = [];
  const failureKinds = new Set<string>();
  let userMessages = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.message;
    if (!message) continue;
    if (message.role === "user") {
      userMessages++;
      if (recentTurns.length < MAX_RECENT_TURNS) {
        const text = typeof message.content === "string"
          ? message.content
          : (message.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ");
        if (text?.trim()) recentTurns.push(clip(text, MAX_TURN_CHARS));
      }
    } else if (message.role === "toolResult") {
      if (message.toolName && recentTools.length < MAX_TOOLS && !recentTools.includes(message.toolName)) {
        recentTools.push(message.toolName);
      }
      if (message.isError && message.toolName) failureKinds.add(`${message.toolName}_error`);
    }
    if (userMessages > MAX_RECENT_TURNS && recentTools.length >= MAX_TOOLS) break;
  }

  return {
    recentTurns: recentTurns.reverse(),
    recentTools,
    failureKinds: [...failureKinds].slice(0, 4),
    attempt: Math.max(0, userMessages - 1),
    isFollowUp: userMessages > 0,
  };
}

/**
 * Build the bounded context block and facts for one task.
 * `prompt` is the expanded user prompt for this turn.
 */
export async function collectContext(
  prompt: string,
  cwd: string,
  opts: {
    sessionManager?: any;
    activeTools?: string[];
    contextTokens?: number;
    hasImages?: boolean;
    contextFiles?: string[];
  } = {},
): Promise<CollectedContext> {
  const referencedPaths = extractPaths(prompt, cwd);
  const session = opts.sessionManager ? readSessionSignals(opts.sessionManager) : { recentTurns: [], recentTools: [], failureKinds: [], attempt: 0, isFollowUp: false };
  const repo = await collectRepoFacts(cwd);
  const language = inferLanguage(referencedPaths);

  const lines: string[] = [];
  lines.push(`Working directory: ${basename(cwd) || cwd}`);
  if (repo.isGitRepo) {
    lines.push(`Git branch: ${repo.branch ?? "unknown"}${repo.dirtyFiles !== undefined ? `, ${repo.dirtyFiles} uncommitted file(s)` : ""}`);
  } else {
    lines.push("Not a git repository.");
  }
  if (referencedPaths.length) lines.push(`Files named in the request: ${referencedPaths.join(", ")}`);
  else lines.push("The request names no specific file.");
  if (language) lines.push(`Primary language of those files: ${language}`);
  if (opts.contextFiles?.length) lines.push(`Project instruction files loaded: ${opts.contextFiles.slice(0, 4).map((p) => basename(p)).join(", ")}`);
  if (session.recentTools.length) lines.push(`Tools already used in this session: ${session.recentTools.join(", ")}`);
  if (session.failureKinds.length) lines.push(`Recent tool failures: ${session.failureKinds.join(", ")}`);
  if (session.recentTurns.length) {
    lines.push(`Earlier requests in this session: ${session.recentTurns.map((t) => `"${t}"`).join(" then ")}`);
  } else {
    lines.push("This is the first request in the session.");
  }
  if (opts.hasImages) lines.push("The request includes an image attachment.");

  const relevantContext = clip(lines.join("\n"), MAX_CONTEXT_CHARS).replace(/ (Git branch|Files named|Primary language|Project instruction|Tools already|Recent tool|Earlier requests|This is the first|The request names|The request includes|Not a git)/g, "\n$1");

  const facts: TaskFacts = {
    language,
    hasImages: opts.hasImages ?? false,
    estimatedContextTokens: opts.contextTokens ?? Math.ceil(prompt.length / 4),
    requiredTools: (opts.activeTools ?? []).slice(0, MAX_TOOLS),
    attempt: session.attempt,
    priorFailureKinds: session.failureKinds,
  };

  return {
    relevantContext,
    facts,
    observed: { referencedPaths, recentTools: session.recentTools, repo, isFollowUp: session.isFollowUp },
  };
}

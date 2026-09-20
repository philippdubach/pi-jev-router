import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execAsync = promisify(exec);

export interface WorktreeSession {
  repoCwd: string;
  worktreePath: string;
  branch: string;
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git rev-parse --is-inside-work-tree", { cwd });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function createWorktree(repoCwd: string, taskId: string): Promise<WorktreeSession | null> {
  const isGit = await isGitRepo(repoCwd);
  if (!isGit) return null;

  const baseDir = join(tmpdir(), "pi-jev-worktrees");
  mkdirSync(baseDir, { recursive: true });

  const worktreePath = join(baseDir, taskId);
  const branch = `task/${taskId}`;

  // Clean up any stale worktree at this path
  if (existsSync(worktreePath)) {
    try {
      await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: repoCwd });
    } catch {}
  }

  try {
    await execAsync(`git worktree add -b "${branch}" "${worktreePath}" HEAD`, { cwd: repoCwd });
    return { repoCwd, worktreePath, branch };
  } catch (err) {
    // If worktree add fails, fall back to repoCwd
    return null;
  }
}

export async function cleanupWorktree(session: WorktreeSession): Promise<void> {
  try {
    await execAsync(`git worktree remove --force "${session.worktreePath}"`, { cwd: session.repoCwd });
  } catch {}
  try {
    await execAsync(`git branch -D "${session.branch}"`, { cwd: session.repoCwd });
  } catch {}
}

export async function mergeWorktree(session: WorktreeSession): Promise<{ ok: boolean; diff: string; error?: string }> {
  try {
    // Check if worker made commits or uncommitted changes
    await execAsync(`git add -A`, { cwd: session.worktreePath });
    const { stdout: status } = await execAsync(`git status --porcelain`, { cwd: session.worktreePath });
    if (status.trim()) {
      await execAsync(`git commit -m "task: apply verified changes for ${session.branch}"`, { cwd: session.worktreePath });
    }

    // Get diff against HEAD of repoCwd
    const { stdout: diff } = await execAsync(`git diff HEAD..${session.branch}`, { cwd: session.repoCwd });
    if (!diff.trim()) {
      return { ok: true, diff: "" };
    }

    // Apply the diff to the target repository
    await execAsync(`git merge --no-edit "${session.branch}"`, { cwd: session.repoCwd });
    return { ok: true, diff };
  } catch (err: any) {
    return { ok: false, diff: "", error: String(err?.message || err) };
  }
}

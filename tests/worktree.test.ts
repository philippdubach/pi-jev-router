import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createWorktree, cleanupWorktree, mergeWorktree } from "../src/worktree.ts";

async function test() {
  const repoDir = join(tmpdir(), `test-repo-${Date.now().toString(36)}`);
  mkdirSync(repoDir, { recursive: true });

  execSync("git init -q", { cwd: repoDir });
  execSync("git config user.name 'Test'", { cwd: repoDir });
  execSync("git config user.email 'test@example.com'", { cwd: repoDir });
  writeFileSync(join(repoDir, "base.txt"), "hello", "utf8");
  execSync("git add base.txt && git commit -qm 'initial commit'", { cwd: repoDir });

  const taskId = "t123";
  const session = await createWorktree(repoDir, taskId);
  if (!session) throw new Error("createWorktree returned null");

  // Modify in worktree
  writeFileSync(join(session.worktreePath, "feature.txt"), "new feature", "utf8");

  // Merge worktree
  const res = await mergeWorktree(session);
  if (!res.ok) throw new Error("mergeWorktree failed: " + res.error);

  // Clean up
  await cleanupWorktree(session);

  // Verify feature.txt exists in repoDir
  const { existsSync, readFileSync } = await import("node:fs");
  if (!existsSync(join(repoDir, "feature.txt"))) {
    throw new Error("feature.txt did not merge into repoDir");
  }
  const content = readFileSync(join(repoDir, "feature.txt"), "utf8");
  if (content !== "new feature") throw new Error("wrong content: " + content);

  // Clean test repo
  rmSync(repoDir, { recursive: true, force: true });
  console.log("PASS worktree test");
}

test().catch((e) => {
  console.error("FAIL worktree test:", e);
  process.exit(1);
});

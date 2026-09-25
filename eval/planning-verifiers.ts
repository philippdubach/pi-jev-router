/**
 * Planning verifiers that can fail.
 *
 * The original planning check looked for five keywords, which every model
 * cleared. Each verifier here checks a structural property a plan can get
 * wrong: an ordering, a dependency, an owner. Both are checked three ways in
 * tests: they fail on an empty state, pass on a hand-written correct plan,
 * and fail on a plausible wrong plan.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VerifyResult { ok: boolean; message: string }

function load(workspaceDir: string, names: string[]): { text: string } | { error: string } {
  const target = names.map((n) => join(workspaceDir, n)).find((p) => existsSync(p));
  if (!target) return { error: `No output file. Checked: ${names.join(", ")}` };
  const text = readFileSync(target, "utf8");
  if (text.trim().length < 250) return { error: "Plan is shorter than 250 characters." };
  return { text };
}

/** Ordered list items: numbered lines, in document order. */
export function numberedSteps(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => /^\d+[.)]\s+\S/.test(l)).map((l) => l.replace(/^\d+[.)]\s*/, ""));
}

/**
 * Expand-and-contract migration.
 *
 * The prompt asks for a schema change that stays backwards compatible for
 * one release. A correct plan adds the new column, dual-writes, backfills,
 * switches reads, stops writing the old column, and only then drops it in a
 * later release. The failure this catches: dropping the column in the same
 * release that stops writing to it, which breaks any instance still on the
 * previous version.
 */
export async function verifyMigrationPlan(workspaceDir: string): Promise<VerifyResult> {
  const r = load(workspaceDir, ["migration-plan.md", "plan.md", "output.md"]);
  if ("error" in r) return { ok: false, message: r.error };
  const lower = r.text.toLowerCase();
  const errors: string[] = [];

  const phaseOf = (re: RegExp) => { const m = lower.match(re); return m ? (m.index ?? -1) : -1; };
  const add = phaseOf(/\b(add|create|introduce)\b[^.\n]{0,60}\b(columns?|fields?)\b/);
  const dualWrite = phaseOf(/\b(dual[- ]write|write to both|write both|writes? (to )?(the )?(new|both))/);
  const backfill = phaseOf(/\bbackfill/);
  const switchRead = phaseOf(/\b(switch|cut ?over|move|migrate)\b[^.\n]{0,40}\bread/);
  const stopWrite = phaseOf(/\b(stop|cease|remove)\b[^.\n]{0,40}\bwrit(e|ing)\b[^.\n]{0,40}\b(old|legacy|previous)/);
  const drop = phaseOf(/\b(drop|delete|remove)\b[^.\n]{0,40}\b(old|legacy|previous)?\s*(columns?|fields?)\b/);

  if (add < 0) errors.push("No step adds the new column.");
  if (dualWrite < 0) errors.push("No dual-write phase: the old and new column must both be written during the transition.");
  if (backfill < 0) errors.push("No backfill step for existing rows.");
  if (drop < 0) errors.push("The old column is never dropped; the plan does not finish.");

  // Ordering. Each index is a position in the text.
  if (add >= 0 && dualWrite >= 0 && dualWrite < add) errors.push("Dual-write appears before the column exists.");
  if (backfill >= 0 && dualWrite >= 0 && backfill < dualWrite) errors.push("Backfill runs before dual-write starts, so rows written in between are missed.");
  if (switchRead >= 0 && backfill >= 0 && switchRead < backfill) errors.push("Reads switch to the new column before the backfill, so old rows read as empty.");
  if (stopWrite >= 0 && switchRead >= 0 && stopWrite < switchRead) errors.push("Writes to the old column stop while reads still come from it.");
  if (drop >= 0 && stopWrite >= 0 && drop < stopWrite) errors.push("The column is dropped before writes to it stop.");

  // The critical release boundary: drop must not be in the same release as
  // stop-write. Look for an explicit later-release marker after stop-write
  // and before drop.
  if (drop >= 0 && stopWrite >= 0 && drop > stopWrite) {
    const between = lower.slice(stopWrite, drop);
    const laterRelease = /\b(next|later|following|subsequent|separate|second)\b[^.\n]{0,20}\b(release|deploy|version)\b|\brelease\s*(n\s*\+\s*1|two|2)\b|\bafter\b[^.\n]{0,40}\b(release|deploy)/.test(between);
    if (!laterRelease) errors.push("The old column is dropped in the same release that stops writing to it. An instance still on the previous release would fail. Drop it in a later release.");
  }

  if (errors.length) return { ok: false, message: `Migration plan failed:\n- ${errors.slice(0, 6).join("\n- ")}` };
  return { ok: true, message: "Migration plan passed: expand, dual-write, backfill, switch reads, stop writes, drop in a later release." };
}

/**
 * Incident runbook decomposition.
 *
 * The prompt gives a multi-system failure and asks for ordered steps with an
 * owner each. The failure this catches: a step that depends on a later step,
 * and a named system with no owner.
 */
export const INCIDENT_SYSTEMS = ["database", "queue", "api gateway", "cache"];

export async function verifyIncidentRunbook(workspaceDir: string): Promise<VerifyResult> {
  const r = load(workspaceDir, ["incident-runbook.md", "runbook.md", "output.md"]);
  if ("error" in r) return { ok: false, message: r.error };
  const text = r.text; const lower = text.toLowerCase();
  const errors: string[] = [];

  const steps = numberedSteps(text);
  if (steps.length < 5) errors.push(`Need at least 5 numbered steps; found ${steps.length}.`);

  // Every step names an owner in the form "Owner: <role>" or "(<role>)" at end.
  const ownerless = steps.filter((s) => !/\bowner\s*:\s*\S|\b(owned by|assigned to)\b|\((?:on[- ]call|sre|dba|platform|backend|network|db|ops)[^)]*\)\s*$/i.test(s));
  if (ownerless.length) errors.push(`${ownerless.length} step(s) have no owner. First: "${ownerless[0].slice(0, 70)}"`);

  // Every named system must appear in at least one step.
  for (const sys of INCIDENT_SYSTEMS) {
    if (!steps.some((s) => s.toLowerCase().includes(sys))) errors.push(`No step addresses the ${sys}.`);
  }

  // Forward dependencies: a step that says "after step N" or "once step N"
  // where N is later than itself.
  steps.forEach((s, i) => {
    const m = s.match(/\b(after|once|following|when)\s+step\s+(\d+)/i);
    if (m && Number(m[2]) > i + 1) errors.push(`Step ${i + 1} depends on later step ${m[2]}.`);
  });

  // The cache must not be warmed before the database is confirmed healthy.
  const dbIdx = steps.findIndex((s) => /\bdatabase\b/i.test(s) && /\b(verify|confirm|check|restore|healthy|recover)/i.test(s));
  const cacheIdx = steps.findIndex((s) => /\bcache\b/i.test(s) && /\b(warm|rebuild|repopulate|flush|clear)/i.test(s));
  if (dbIdx >= 0 && cacheIdx >= 0 && cacheIdx < dbIdx) errors.push("The cache is warmed before the database is confirmed healthy; it would cache bad data.");

  // A verification step must exist and must not be first.
  const verifyIdx = steps.findIndex((s) => /\b(verify|confirm|validate)\b/i.test(s));
  if (verifyIdx < 0) errors.push("No verification step.");
  else if (verifyIdx === 0) errors.push("Verification is the first step; there is nothing to verify yet.");

  if (!/\brollback\b/.test(lower)) errors.push("No rollback section.");

  if (errors.length) return { ok: false, message: `Incident runbook failed:\n- ${errors.slice(0, 6).join("\n- ")}` };
  return { ok: true, message: `Incident runbook passed: ${steps.length} owned, ordered steps covering all four systems.` };
}

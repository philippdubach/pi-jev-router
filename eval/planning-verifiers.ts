/**
 * Planning verifiers that can fail.
 *
 * The original planning check looked for five keywords, which every model
 * cleared. Each verifier here checks a structural property a plan can get
 * wrong: an ordering, a dependency, an owner.
 *
 * The first version of these matched phases against the whole document, so
 * a section heading that said "Dual-write" was found before the step that
 * added the column, and a correct plan from Sonnet failed twice. Everything
 * here now matches inside numbered steps only, steps may span several lines,
 * and a Rollback section's own numbered list is not counted as recovery.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VerifyResult { ok: boolean; message: string }

export interface Step { n: number; text: string; line: number }

function load(workspaceDir: string, names: string[]): { text: string } | { error: string } {
  const target = names.map((n) => join(workspaceDir, n)).find((p) => existsSync(p));
  if (!target) return { error: `No output file. Checked: ${names.join(", ")}` };
  const text = readFileSync(target, "utf8");
  if (text.trim().length < 250) return { error: "Plan is shorter than 250 characters." };
  return { text };
}

/**
 * Numbered steps with continuation lines joined. A step ends at the next
 * numbered line, a heading, a horizontal rule, or a blank line followed by a
 * non-indented line. `untilHeading` stops at the first heading matching it,
 * so a Rollback section's list is excluded from recovery steps.
 */
export function parseSteps(text: string, untilHeading?: RegExp): Step[] {
  const lines = text.split("\n");
  const steps: Step[] = [];
  let current: Step | null = null;
  let headingStep = false; // current step came from a "### Step N:" heading; prose beneath belongs to it

  // A numbered list under an "Invariants", "Constraints" or "Overview"
  // heading is preamble, not steps, but only when a later non-preamble
  // heading introduces the real plan. Consecutive preamble headings are one
  // preamble.
  const PREAMBLE = /^#{1,6}\s.*\b(invariants?|constraints?|assumptions?|overview|context|goals?|background|summary|ground rules?)\b/i;
  const STEP_HEADING = /^#{1,6}\s+(?:\*\*)?step\s+(\d+)\b[:.)]?\s*(.*)$/i;
  const headingLines = lines.map((l, i) => (/^#{1,6}\s/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  const skip = new Set<number>();
  for (let h = 0; h < headingLines.length; h++) {
    if (!PREAMBLE.test(lines[headingLines[h]].trim())) continue;
    let k = h + 1;
    while (k < headingLines.length && PREAMBLE.test(lines[headingLines[k]].trim())) k++;
    if (k >= headingLines.length) continue;
    for (let i = headingLines[h] + 1; i < headingLines[k]; i++) skip.add(i);
    h = k - 1;
  }

  const flush = () => { if (current) { steps.push(current); current = null; headingStep = false; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (/^#{1,6}\s/.test(line) || /^-{3,}$/.test(line)) {
      flush();
      if (untilHeading && /^#{1,2}\s/.test(line) && untilHeading.test(line)) break;
      const sh = line.match(STEP_HEADING);
      if (sh) { current = { n: Number(sh[1]), text: sh[2], line: i }; headingStep = true; }
      continue;
    }

    // Under a step heading, every non-blank line is part of the step.
    if (headingStep && current) {
      if (line) current.text += " " + line.replace(/^[-*]\s+/, "");
      continue;
    }

    // "1. text", "1) text", "Step 1. text", "**Step 1.** text", "- **1.1** text"
    const m = line.match(/^(?:[-*]\s+)?(?:\*\*)?(?:step\s+)?(\d+)(?:\.\d+)?[.):]?\*{0,2}\s+(.*)$/i);
    if (m && skip.has(i)) continue;
    if (m) { flush(); current = { n: Number(m[1]), text: m[2], line: i }; continue; }

    if (current) {
      if (line === "") {
        const next = lines[i + 1] ?? "";
        if (!/^\s+\S/.test(next)) flush();
        continue;
      }
      if (/^\s+\S/.test(raw) || /^[a-z(`*]/.test(line)) { current.text += " " + line; continue; }
      flush();
    }
  }
  flush();
  return steps;
}

/** Index of the first step whose text matches, else -1. */
function firstStep(steps: Step[], re: RegExp | ((t: string) => boolean)): number {
  return steps.findIndex((s) => (typeof re === "function" ? re(s.text) : re.test(s.text)));
}

/**
 * Expand-and-contract migration.
 *
 * A correct plan adds the new column, dual-writes, backfills, switches reads,
 * stops writing the old column, and drops it in a later release. The failure
 * this catches: dropping the column in the same release that stops writing to
 * it, which breaks an instance still on the previous release.
 */
export async function verifyMigrationPlan(workspaceDir: string): Promise<VerifyResult> {
  const r = load(workspaceDir, ["migration-plan.md", "plan.md", "output.md"]);
  if ("error" in r) return { ok: false, message: r.error };
  const text = r.text;
  const steps = parseSteps(text, /rollback/i).map((s) => ({ ...s, text: s.text.toLowerCase().replace(/[*_`]/g, "") }));
  const errors: string[] = [];
  if (steps.length < 5) errors.push(`Need at least 5 numbered steps before the Rollback section; found ${steps.length}.`);

  // Each phase is matched as the step's action, not a passing mention. A
  // sentence that negates the verb ("do not drop … yet") or references the
  // phase from elsewhere ("rows left null, to be caught by backfill") is
  // not that phase.
  const NEG = /\b(do not|don't|never|must not|should not|without|not yet|is not|are not|not)\b[^.]{0,20}$/;
  const sentences = (t: string) => t.split(/(?<=[.;:])\s+/);
  const asAction = (verb: RegExp, object: RegExp, reject?: RegExp) => (t: string) =>
    sentences(t).some((sen) => {
      const m = sen.match(verb); if (!m) return false;
      const before = sen.slice(0, m.index ?? 0); if (NEG.test(before)) return false;
      const after = sen.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 90);
      if (reject && reject.test(after)) return false;
      return object.test(after);
    });

  const add = firstStep(steps, asAction(/\b(add|adds|adding|create|creates|introduce|introduces)\b/, /^[^.]{0,80}\b(columns?|fields?)\b/));
  const dualWrite = firstStep(steps, (t) =>
    /\b(dual[- ]?writ(e|es|ing)|write[s]? (to )?both|writ(e|es|ing) (both|all three|the new and|old and new)|additionally[^.]{0,30}\bwrit)/.test(t) &&
    !/\bwrite only\b[^.]{0,20}\bfull_name\b/.test(t));
  const backfillAsVerb = asAction(/\b(backfill|backfills)\b/, /^/, /^[^.]{0,4}\b(later|job)\b.*\b(will|to be)\b/);
  const backfillAsObject = asAction(/\b(run|runs|execute|executes|perform|performs|launch|launches|start|starts|kick off)\b/, /^[^.]{0,50}\b(backfill|existing rows|historical rows)\b/, /\b(caught|filled|handled|covered) by\b/);
  const backfill = firstStep(steps, (t) => {
    // A forward reference is a mention, not the action.
    // "used by the backfill job", "caught by backfill": a reference to the
    // backfill from another step, not the backfill itself.
    if (/\bby (the |a )?backfill\b/.test(t) && !backfillAsObject(t) && !/^backfill/.test(t.replace(/^\([^)]*\)\s*/, ""))) return false;
    return backfillAsVerb(t) || backfillAsObject(t);
  });
  const stopWrite = firstStep(steps, asAction(/\b(stop|stops|cease|ceases|remove|removes)\b/, /^[^.]{0,60}\b(writ(e|es|ing)|write path|populating)\b/));
  const drop = firstStep(steps, asAction(/\b(drop|drops|delete|deletes|remove|removes)\b/, /^[^.]{0,60}\b(columns?|fields?)\b/, /^[^.]{0,20}\bfrom\b[^.]{0,40}\b(write|read) path/));
  const switchRead = firstStep(steps, (t) =>
    sentences(t).some((sentence) =>
      (/\b(switch|switches|switching|move|moves|migrate|migrates|cut ?over|flip|flips|point|points|update|updates|change|changes)\b(?:(?!\bwrit)[^.]){0,60}\bread/.test(sentence) ||
       /\bread(s|ing)?\b[^.]{0,60}\binstead of\b/.test(sentence)) &&
      !/\b(still|unchanged|no (behaviou?r )?change|not (yet )?changed|continue[s]? to read)\b/.test(sentence)));

  if (process.env.PLAN_VERIFY_DEBUG) {
    for (const [name, i] of Object.entries({ add, dualWrite, backfill, switchRead, stopWrite, drop }))
      console.error(`  [phase] ${name.padEnd(10)} -> step#${i + 1}: ${(steps[i]?.text ?? "-").slice(0, 100)}`);
  }
  if (add < 0) errors.push("No step adds the new column.");
  if (dualWrite < 0) errors.push("No dual-write step: the old and new column must both be written during the transition.");
  if (backfill < 0) errors.push("No backfill step for existing rows.");
  if (switchRead < 0) errors.push("No step switches reads to the new column.");
  if (stopWrite < 0) errors.push("No step stops writing the old column.");
  if (drop < 0) errors.push("The old column is never dropped; the plan does not finish.");

  const order: Array<[string, number, string, number, string]> = [
    ["add", add, "dual-write", dualWrite, "Dual-write appears before the column exists."],
    ["dual-write", dualWrite, "backfill", backfill, "Backfill runs before dual-write starts, so rows written in between are missed."],
    ["backfill", backfill, "switch reads", switchRead, "Reads switch to the new column before the backfill, so old rows read as empty."],
    ["switch reads", switchRead, "stop writes", stopWrite, "Writes to the old column stop while reads still come from it."],
    ["stop writes", stopWrite, "drop", drop, "The column is dropped before writes to it stop."],
  ];
  for (const [, a, , b, msg] of order) if (a >= 0 && b >= 0 && b < a) errors.push(msg);

  // Release boundary. Between the stop-write step and the drop step there
  // must be a release heading, or the step text itself must defer the drop.
  // `drop >= stopWrite`: the same step doing both is the most flagrant
  // same-release case, and `>` alone would have skipped it.
  if (stopWrite >= 0 && drop >= 0 && drop >= stopWrite) {
    const lines = text.split("\n");
    const from = steps[stopWrite].line, to = steps[drop].line;
    const headingBetween = drop > stopWrite && lines.slice(from + 1, to).some((l) => /^#{1,6}\s.*\b(release|deploy|version|phase)\b/i.test(l));
    const deferredInText = /\b(later|next|subsequent|following|separate)\b[^.]{0,30}\b(release|deploy|version|migration)\b/.test(steps[drop].text);
    if (!headingBetween && !deferredInText) {
      errors.push("The old column is dropped in the same release that stops writing to it. An instance still on the previous release would fail. Drop it in a later release.");
    }
  }

  if (errors.length) return { ok: false, message: `Migration plan failed:\n- ${errors.slice(0, 6).join("\n- ")}` };
  return { ok: true, message: `Migration plan passed: ${steps.length} steps, expand, dual-write, backfill, switch reads, stop writes, drop in a later release.` };
}

/**
 * Incident runbook decomposition.
 *
 * Every step needs an owner, every named system needs a step, no step may
 * depend on a later one, and the cache must not be warmed before the database
 * is confirmed healthy.
 */
export const INCIDENT_SYSTEMS = ["database", "queue", "api gateway", "cache"];

const OWNER = /\bowner\s*[:\-]\s*\S|\b(owned by|assigned to|responsible)\b\s*[:\-]?\s*\S/i;

export async function verifyIncidentRunbook(workspaceDir: string): Promise<VerifyResult> {
  const r = load(workspaceDir, ["incident-runbook.md", "runbook.md", "output.md"]);
  if ("error" in r) return { ok: false, message: r.error };
  const text = r.text;
  const steps = parseSteps(text, /rollback/i);
  const errors: string[] = [];

  if (steps.length < 5) errors.push(`Need at least 5 numbered recovery steps before the Rollback section; found ${steps.length}.`);

  const ownerless = steps.filter((s) => !OWNER.test(s.text));
  if (ownerless.length) errors.push(`${ownerless.length} step(s) have no owner. First: "${ownerless[0].text.slice(0, 70)}"`);

  for (const sys of INCIDENT_SYSTEMS) {
    const re = new RegExp(sys === "queue" ? "\\b(message )?queue\\b" : `\\b${sys.replace(" ", "\\s+")}\\b`, "i");
    if (!steps.some((s) => re.test(s.text))) errors.push(`No step addresses the ${sys}.`);
  }

  steps.forEach((s, i) => {
    for (const m of s.text.matchAll(/\b(after|once|following|when|until)\s+step\s+(\d+)/gi)) {
      if (Number(m[2]) > i + 1) errors.push(`Step ${i + 1} depends on later step ${m[2]}.`);
    }
  });

  const dbIdx = steps.findIndex((s) => /\bdatabase\b/i.test(s.text) && /\b(verify|verification|confirm|check|health|restore|recover)/i.test(s.text));
  const cacheIdx = steps.findIndex((s) => /\bcache\b/i.test(s.text) && /\b(warm|rebuild|repopulat|reload)/i.test(s.text));
  if (dbIdx >= 0 && cacheIdx >= 0 && cacheIdx < dbIdx) errors.push("The cache is warmed before the database is confirmed healthy; it would cache bad data.");

  // A verification step must exist somewhere after the first step. A first
  // step that confirms the partition has cleared is a sensible precondition,
  // not the verification the prompt asks for.
  const verifyLater = steps.slice(1).some((s) => /\b(verify|verification|validate)\b/i.test(s.text));
  if (!verifyLater) errors.push("No verification step after the first step.");

  if (!/^#{1,6}\s.*rollback|\brollback\b/im.test(text)) errors.push("No rollback section.");

  if (errors.length) return { ok: false, message: `Incident runbook failed:\n- ${errors.slice(0, 6).join("\n- ")}` };
  return { ok: true, message: `Incident runbook passed: ${steps.length} owned, ordered steps covering all four systems.` };
}

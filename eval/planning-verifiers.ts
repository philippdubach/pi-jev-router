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

  // A numbered list before the plan's real release/phase/step structure
  // starts - "Invariants", "Business Rules", a naming-rules section, an
  // architecture overview - is preamble, not steps. A keyword allowlist for
  // "definitional" headings chases the model's wording forever ("Business
  // Rules", "Naming Rules", "Splitting Logic", "Business logic cutover",
  // "Cutover: naming rules applied to reads", ...: every paraphrase needs
  // its own list entry, and a release/phase disqualifier alone still let
  // "Release 2: business logic" hide a real step). The structural fact that
  // actually distinguishes them: a plan's real steps always live under a
  // heading that names a numbered release, phase or step ("Release 1",
  // "Phase 2", "Step 3" - every real plan we've seen marks its chronology
  // this way, in a markdown heading, somewhere). So: find the *first*
  // heading in the whole document that names one, and treat everything at
  // or after it as real content; everything strictly before it - no matter
  // what its own heading text says, paraphrase or not - is preamble. A
  // document with no such heading anywhere skips nothing (there's no
  // reference point to be "before").
  const PHASE_MARKER_HEADING = /\b(releases?|phases?|steps?)\s+\d+\b/i;
  const STEP_HEADING = /^#{1,6}\s+(?:\*\*)?step\s+(\d+)\b[:.)]?\s*(.*)$/i;
  const headingLines = lines.map((l, i) => (/^#{1,6}\s/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  const skip = new Set<number>();
  const firstPhaseHeading = headingLines.find((li) => PHASE_MARKER_HEADING.test(lines[li].trim()));
  if (firstPhaseHeading !== undefined) {
    for (let i = 0; i < firstPhaseHeading; i++) skip.add(i);
  }

  const flush = () => { if (current) { steps.push(current); current = null; headingStep = false; } };

  // A fenced code block (```sql ... ```) commonly holds the DDL that *is*
  // the step's action ("DROP COLUMN", "ALTER TABLE"). Its lines are
  // uppercase SQL, which the plain continuation heuristic below treats as
  // the start of a new, unindented paragraph and flushes on. Inside a
  // fence, every line belongs to the current step regardless of case.
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (/^```/.test(line)) {
      inFence = !inFence;
      if (current) current.text += " " + line;
      continue;
    }

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
        // A blank line before a fenced code block ("**Step 11:**\n\n```sql")
        // is not a paragraph break; the fence carries the step's own action.
        if (!/^\s+\S/.test(next) && !/^```/.test(next.trim())) flush();
        continue;
      }
      if (inFence || /^\s+\S/.test(raw) || /^[a-z(`*]/.test(line)) { current.text += " " + line; continue; }
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
  const steps = parseSteps(text, /rollback/i).map((s) => ({
    ...s,
    // A qualified reference like `users.full_name` embeds a "." that is not
    // a sentence boundary. Left alone, it breaks every same-sentence
    // "[^.]{0,N}" window the phase detectors use below: the object regex
    // can't see past it, so "add ... columns" fails to match "add
    // users.first_name and users.last_name columns." A dot only ends a
    // sentence when followed by whitespace or end of string, so a dot
    // immediately followed by a non-space character is a qualifier, not a
    // terminator; replace it with a space so the word after it still reads
    // as its own token (full_name stays matchable) without a "." in the way.
    text: s.text.toLowerCase().replace(/[*_`]/g, "").replace(/\.(?=\S)/g, " "),
  }));
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
    // "write full_name, first_name, and last_name together" names all three
    // columns instead of saying "both" or "all three"; "together" alone is
    // not the tell, though - "writes first_name and last_name together on
    // every save" only ever mentions the new columns, so it is a plain
    // single-column-family write, not a dual-write. fullname must be a
    // column-list item written together with the others - immediately
    // after the verb (only a bare "to" in between) - not a source the new
    // columns are derived FROM: "writes first_name and last_name, split
    // out of full_name, together" and "... based on full_name together"
    // both name full_name as the split/derivation source, several words
    // and a preposition away from the verb, not as something written.
    /\b(dual[- ]?writ(e|es|ing)|write[s]? (to )?both|writ(e|es|ing) (both|all three|the new and|old and new)|additionally[^.]{0,30}\bwrit|writ(e|es|ing)\b(?:\s+to)?(?:(?!\b(from|of|based|split|derived|parsed)\b)[^.]){0,20}\bfullname\b[^.]{0,60}\btogether\b)/.test(t) &&
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
  const stopWriteVerbFirst = asAction(/\b(stop|stops|cease|ceases|remove|removes)\b/, /^[^.]{0,60}\b(writ(e|es|ing)|write path|populating)\b/);
  // Object-first forms: "Old Writes Removed" (a heading title puts the
  // participle after its object) and "Write Path: Exclusively first_name
  // and last_name" (states the write path is only the new columns, without
  // an explicit "stop" verb). Both need the two checks every other
  // detector in this file gets: a negation guard ("old writes are NOT
  // removed yet" is the opposite claim) and an object requirement scoped to
  // what's actually being talked about - "the write lock is removed" names
  // no write-path/write at all, and "the write path is NOT exclusively
  // first_name" is negated. Neither form previously checked either.
  // Anchored to the two label/title shapes the real artifacts actually
  // use, not a generic "writes...removed anywhere" scan: "Deploy
  // Application Code with Old Writes Removed" (a heading title puts "with"
  // right before the participial phrase) and "Write Path: Exclusively
  // first_name and last_name." (a colon-led label). A forward reference or
  // a conditional ("Monitor error rates UNTIL old writes are removed.",
  // "Plan a later release WHERE writes are removed.", "UNTIL the write
  // path is exclusively first_name, keep dual writes.") states a future or
  // hypothetical condition, not a completed cutover, and never takes
  // either shape - "with" doesn't precede a bare forward-referenced
  // "removed", and "write path" isn't followed by a label colon in a
  // subordinate clause - so anchoring to the real shape rejects every
  // forward reference without a separate keyword scan. A negation/
  // forward-reference word check is kept anyway, in front of the match,
  // as a second line of defense.
  const FORWARD_REF = /\b(until|once|before|after|when|where|if)\b/i;
  const stopWriteObjectFirst = (sentence: string): boolean => {
    // "... with Old Writes Removed (Release 3 ...)". The object must be
    // the write(s) themselves, adjacent to "removed" with only an optional
    // "is"/"are": "the write LOCK is removed" removes a lock, not a write,
    // and the plural/gerund form (not bare "write") keeps a compound noun
    // like "write lock" from qualifying at all.
    const removedMatch = sentence.match(/\bwith\b[^.]{0,15}\bwrit(es|ing)\b\s*(?:is\s+|are\s+)?removed\b/);
    if (removedMatch) {
      const before = sentence.slice(0, removedMatch.index ?? 0);
      if (!NEG.test(before) && !FORWARD_REF.test(before)) return true;
    }

    // "Write Path: Exclusively first_name and last_name." - a label, not a
    // clause: the colon is what makes "write path" the subject of its own
    // sentence fragment rather than the object of some other verb
    // ("Until THE WRITE PATH is exclusively..."). The negation can sit
    // *inside* the match ("the write path is NOT exclusively first_name"),
    // so check the gap between the colon and "exclusively" specifically,
    // not just the text before the whole match.
    const pathMatch = sentence.match(/\bwrite path\s*:\s*([^.]{0,10})\bexclusively\b[^.]{0,20}\b(firstname|lastname|new columns?)\b/);
    if (pathMatch) {
      const before = sentence.slice(0, pathMatch.index ?? 0);
      if (!/\b(not|never|isn't|is not|no longer)\b/i.test(pathMatch[1]) && !NEG.test(before) && !FORWARD_REF.test(before)) return true;
    }

    return false;
  };
  const stopWrite = firstStep(steps, (t) => stopWriteVerbFirst(t) || sentences(t).some(stopWriteObjectFirst));

  // The drop step must be judged per verb occurrence, not per sentence (or
  // just the first verb match, which the shared `asAction` helper only
  // ever inspects). "Drop the column and remove it from the ORM model." and
  // "Stop writing ..., remove it from the users model and drop the
  // column." each have two independent verb phrases; an ORM mention in one
  // must not hide a real column drop sitting in the other. Splitting the
  // sentence on "and"/"," outright over-corrects: "drop users.full_name
  // and its old-column-specific indexes" is a *single* drop with a
  // compound object, and splitting on "and" would cut "column" away from
  // "drop" entirely, hiding a real drop. Instead, each verb occurrence gets
  // its own object window, but that window stops at the *next* drop/remove
  // verb in the same sentence rather than running the usual fixed length -
  // long enough to reach a same-clause compound object, short enough not to
  // reach into an unrelated second clause's object.
  const DROP_VERB = /\b(drop|drops|delete|deletes|remove|removes)\b/g;
  // "fullname" gets its own, short window: "drop any default, trigger,
  // index, or view that DEPENDS ON fullname" names fullname as what an
  // ancillary object references, many words after the verb, not as what's
  // being dropped. It must not cross "writ" ("remove every WRITE to
  // fullname" is the stop-write step, not a drop), and what follows
  // "fullname" must look like the end of an object, not fullname modifying
  // something else: "remove fullname FROM ALL WRITE PATHS" stops writing
  // it, "remove the fullname INPUT SHAPE" removes an API field - neither
  // drops the column. A clause boundary, "and" (a list continues: "fullname
  // and its indexes"), or "column"/"field" (fullname modifies the object
  // instead of being it) are the only things allowed to follow.
  // "columns?|fields?" keeps the wider window - it still needs to reach a
  // same-clause compound object like "drop users.full_name and its
  // old-column-specific indexes".
  const DROP_OBJECT = /^[^.]{0,60}\b(columns?|fields?)\b|^(?:(?!\bwrit)[^.]){0,20}\bfullname\b(?=[,;]|\s+and\b|\s+columns?\b|\s+fields?\b|\W*$)/;
  // The object must be the column itself, not something merely mentioning
  // "column" as the thing another object sits ON: "Drop the leftover index
  // on the old column." drops an index, not the column, and every plan
  // that includes it as a later, correctly-timed decoy would otherwise let
  // that later index-drop be counted as *the* real column drop. Reject
  // when the immediate object (right after the verb) is an index,
  // constraint or key rather than the column.
  const DROP_NOT_COLUMN_ITSELF = /^[^.]{0,20}\b(index(es)?|constraints?|keys?)\b/;
  // The ORM reject only applies when the verb's window names no database
  // target at all: "Remove the column from the ORM model" (Opus's real
  // phrasing) never mentions a database, so it's the application-layer
  // step told from the model's side, not the migration. "Drop the column
  // from the ORM and the database." and "Delete the field from the ORM
  // model and from Postgres." both also name a real database target in
  // the same window, so they are the real drop with a courtesy mention of
  // the ORM, not the other way around - the gap alone can't tell those
  // apart (both fit "from the ORM" within any workable window), so the
  // reject must check for the *absence* of a database target, not merely
  // the gap after "from".
  const DROP_ORM_ONLY = /^[^.]{0,20}\bfrom\b[^.]{0,15}\b(the )?(orm( model)?|schema cache)\b/;
  const DROP_DB_TARGET = /\b(database|db|table|postgres|mysql|schema migration|alter table)\b/i;
  const DROP_REJECT = (after: string): boolean =>
    /^[^.]{0,20}\bfrom\b[^.]{0,40}\b(write|read) path\b/.test(after) ||
    (DROP_ORM_ONLY.test(after) && !DROP_DB_TARGET.test(after));
  const sentenceHasColumnDrop = (sentence: string): boolean => {
    const verbMatches = [...sentence.matchAll(DROP_VERB)];
    for (let i = 0; i < verbMatches.length; i++) {
      const m = verbMatches[i];
      const idx = m.index ?? 0;
      const before = sentence.slice(0, idx);
      if (NEG.test(before)) continue;
      const nextVerbIdx = verbMatches[i + 1]?.index ?? Math.min(sentence.length, idx + m[0].length + 90);
      const after = sentence.slice(idx + m[0].length, nextVerbIdx);
      if (DROP_NOT_COLUMN_ITSELF.test(after)) continue;
      if (DROP_REJECT(after)) continue;
      if (DROP_OBJECT.test(after)) return true;
    }
    return false;
  };
  const drop = firstStep(steps, (t) => sentences(t).some(sentenceHasColumnDrop));
  const switchRead = firstStep(steps, (t) =>
    sentences(t).some((sentence) =>
      // The verb-first form ("switch reads", "behavior changes (reads in
      // release 3, writes in release 4...)") must not cross a parenthetical:
      // excluding "(" from the gap stops a prep step that merely lists which
      // release *later* changes each reader's behavior from being read as
      // switching reads itself, while still matching "switch reads to X".
      (/\b(switch|switches|switching|move|moves|migrate|migrates|cut ?over|flip|flips|point|points|update|updates|change|changes)\b(?:(?!\bwrit)[^.(]){0,60}\bread/.test(sentence) ||
       /\bread(s|ing)?\b[^.]{0,60}\binstead of\b/.test(sentence) ||
       // The read-first form: "All reads (display, search, ...) use
       // `first_name` / `last_name`." or "Read path: read directly from
       // `first_name`." states the same fact without an explicit "switch"
       // verb before "read". Parens are allowed here since the reads being
       // enumerated, not the verb, own this clause. The object must be
       // checked: "reads from the replica use a snapshot" and "Reads come
       // from full_name" both match the verb phrase but say nothing about
       // switching to the new column (the second is the *old* column), so
       // require first_name/last_name/"new column(s)" to actually follow -
       // immediately, not merely somewhere in a loose window: "Reads use
       // full_name while first_name and last_name fill in" would otherwise
       // find first_name across the old-column mention, in a clause that
       // isn't even this verb's object. Excluding "fullname" from the gap
       // stops the match from reaching past the old column to a later,
       // unrelated clause's new-column mention.
       /\bread(s|ing)?\b(?:(?!\bwrit)[^.]){0,60}\b(use|uses|come from|comes from|target|targets|rely on|relies on|draw from|draws from|directly from|only from|exclusively from|now from)\b(?:(?!\bfullname\b)[^.]){0,20}\b(firstname|lastname|new columns?)\b/.test(sentence) ||
       // Heading-style title case: "Read Path Switched", "Reads Switched
       // Over" puts the verb after "read" instead of before it. Same object
       // requirement: a title alone that never names the new column is not
       // enough to credit the switch.
       /\bread(s|ing)?\b[^.]{0,15}\bswitch(ed|es|ing)?\b(?:(?!\bfullname\b)[^.]){0,20}\b(firstname|lastname|new columns?)\b/.test(sentence)) &&
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

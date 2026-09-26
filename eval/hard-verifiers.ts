/**
 * Strict Simplified Technical English verifier.
 *
 * The earlier writing check tolerated 20% of sentences over 25 words and
 * screened a short word list, so every model passed it. This one enforces the
 * limits the prompt actually states, and reports which sentence failed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_SENTENCE_WORDS = 20;
export const REQUIRED_SECTIONS = ["purpose", "preconditions", "steps", "verification", "rollback"];

const FILLER = [
  "delve", "testament", "tapestry", "furthermore", "moreover", "in conclusion",
  "crucial", "pivotal", "seamless", "robust", "leverage", "utilize",
  "landscape", "underscores", "showcase", "vibrant", "comprehensive", "cutting-edge",
];

const PASSIVE = /\b(is|are|was|were|be|been|being)\s+\w+(ed|en)\b(?!\s+(to|the|a|an)\b)/i;

const IMPERATIVE_BLOCKLIST = /^(the|this|that|it|there|you|we|your|a|an|if|when|after|before)\b/i;

export interface VerifyResult { ok: boolean; message: string }

/** Split prose into sentences, ignoring fenced code and list numbering. */
export function sentencesOf(markdown: string): string[] {
  const noCode = markdown.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const noHeadings = noCode.replace(/^#{1,6}\s.*$/gm, " ");
  return noHeadings
    .replace(/^\s*\d+[.)]\s*/gm, "")
    .replace(/^\s*[-*]\s*/gm, "")
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.replace(/[#*_>\[\]]/g, " ").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 3 && /[a-z]/i.test(s));
}

export function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter(Boolean).length;
}

export async function verifyStrictSTE(workspaceDir: string): Promise<VerifyResult> {
  const candidates = ["runbook.md", "output.md"].map((f) => join(workspaceDir, f));
  const target = candidates.find((p) => existsSync(p));
  if (!target) return { ok: false, message: `No output file. Checked: ${candidates.join(", ")}` };

  const content = readFileSync(target, "utf8");
  if (content.trim().length < 300) return { ok: false, message: "Runbook is shorter than 300 characters." };

  const errors: string[] = [];
  const lower = content.toLowerCase();

  for (const section of REQUIRED_SECTIONS) {
    if (!lower.includes(section)) errors.push(`Missing required section: ${section}`);
  }

  const sentences = sentencesOf(content);
  if (sentences.length < 8) errors.push(`Only ${sentences.length} sentences found; expected a real runbook.`);

  const tooLong = sentences.filter((s) => wordCount(s) > MAX_SENTENCE_WORDS);
  if (tooLong.length > 0) {
    errors.push(
      `${tooLong.length} sentence(s) exceed ${MAX_SENTENCE_WORDS} words. ` +
        `Worst: "${tooLong.sort((a, b) => wordCount(b) - wordCount(a))[0].slice(0, 90)}" (${wordCount(tooLong[0])} words)`,
    );
  }

  const passive = sentences.filter((s) => PASSIVE.test(s));
  if (passive.length > 1) {
    errors.push(`${passive.length} sentence(s) use passive voice. First: "${passive[0].slice(0, 80)}"`);
  }

  // "and" joining two imperatives is a compound instruction, e.g. "Stop the
  // consumer and restart it." A single imperative with a plain list object
  // ("Identify the queue, environment, and owning team.", "Obtain access to
  // the service manager and monitoring dashboard.") also contains "and", but
  // it is one instruction with a multi-item object, not two commands.
  //
  // Default: any long sentence with "and" is a candidate compound (the
  // original, permissive rule) - a requirement on what comes right after
  // "and" turned out to reject most real compounds, since a second command
  // is phrased too many ways ("and then X", "and X it", "and X all Y", "and
  // X Y in Z") to pin down by shape. Two shapes are exempted, because they
  // are provably a list rather than a second command: an Oxford-comma list
  // ("A, B, and C" - at least two commas before this "and"), and a short
  // (<=3 word) noun phrase that runs straight to the sentence's end with
  // nothing further ("and monitoring dashboard.", "and current restart
  // count."). Both exemptions are overridden back to "compound" whenever
  // the tail is unmistakably a second command:
  //   - "and then <...>" (a temporal connective always introduces a second
  //     action);
  //   - "and <word> <pronoun>" (a second verb taking a pronoun object, "and
  //     restart it");
  //   - "and <word> <determiner>" (a second verb taking an article-led
  //     object, "and restart THE service" / "and drain the queue, and
  //     restart THE service" - this also reaches into an Oxford-comma
  //     *chain of imperatives*, where every "item" is its own full command,
  //     not a plain list: "Stop the consumer, drain the queue, and restart
  //     the service.").
  // The short-tail exemption is inverted from a verb blacklist to an
  // allowlist: a blacklist of "unambiguous bare-form verbs" chases
  // paraphrases forever (delete/select were listed; reset/investigate/
  // inform/evict/kill were not, and all slipped through unflagged). The
  // real runbooks this check has to pass need exactly six phrases exempted
  // ("owning team", "consumer group", "restart count" and "current restart
  // count" as Oxford-list/short-tail endings, "monitoring dashboard", and
  // "logs" alone) plus any "-ing" gerund-adjective tail ("owning team" and
  // "monitoring dashboard" both start with one). Nothing else is exempt by
  // shape - a short tail is flagged by default unless it is on this list or
  // starts with a gerund, so a future paraphrase must earn its way onto the
  // list by being a real false positive, not merely by avoiding a blacklist.
  const AND_THEN = /\band\s+then\b/i;
  const AND_PRONOUN_OBJECT = /\band\s+[a-z]+\s+(it|them|him|her|us|this|that|these|those)\b/i;
  const AND_DETERMINER_OBJECT = /\band\s+[a-z]+\s+(the|a|an|its|their|his|her|your|our|this|that|these|those)\b/i;
  const AND_SHORT_NOUN_TAIL = /\band\s+([a-z]+(?:\s+[a-z]+){0,2})\W*$/i;
  const SHORT_TAIL_ALLOWLIST = new Set([
    "owning team", "consumer group", "restart count", "current restart count",
    "monitoring dashboard", "logs",
  ]);
  // A comma-separated list is only a list if every item is a bare noun
  // phrase. A segment that itself reads as "verb + determiner" ("drain the
  // queue") is its own command, which means the whole sentence is a chain
  // of imperatives, not one imperative with a list object - "Stop the
  // consumer, drain the queue, and restart consumers." must still flag
  // even though it has two commas before "and". The opening segment is
  // excluded from this check: "Record THE current replica count, ..."
  // always looks like "verb + determiner" too, for any imperative sentence.
  const VERB_DETERMINER_SEGMENT = /^\s*(?:and\s+)?[a-z]+\s+(the|a|an)\b/i;
  const isCompound = (s: string): boolean => {
    if (!/^[A-Z][a-z]+\b[^.]*\band\b\s+[a-z]+\b/.test(s) || wordCount(s) <= 8) return false;
    if (AND_THEN.test(s) || AND_PRONOUN_OBJECT.test(s) || AND_DETERMINER_OBJECT.test(s)) return true;

    const andIndex = s.search(/\band\b/i);
    const commasBeforeAnd = (s.slice(0, andIndex).match(/,/g) || []).length;
    if (commasBeforeAnd >= 2) {
      const laterSegmentIsCommand = s.split(",").slice(1).some((seg) => VERB_DETERMINER_SEGMENT.test(seg));
      if (!laterSegmentIsCommand) return false; // Oxford-comma list: "A, B, and C"
    }

    const tail = s.match(AND_SHORT_NOUN_TAIL);
    if (tail) {
      const phrase = tail[1].toLowerCase().replace(/\s+/g, " ").trim();
      const firstWord = phrase.split(" ")[0];
      if (/ing$/.test(firstWord) || SHORT_TAIL_ALLOWLIST.has(phrase)) return false;
    }
    return true;
  };
  const compound = sentences.filter(isCompound);
  if (compound.length > 0) {
    errors.push(`${compound.length} compound instruction(s). First: "${compound[0].slice(0, 80)}"`);
  }

  for (const word of FILLER) {
    if (new RegExp(`\\b${word}\\b`, "i").test(content)) errors.push(`Contains filler word: ${word}`);
  }

  // Numbered steps must start with an imperative verb.
  const steps = content.split("\n").filter((l) => /^\s*\d+[.)]\s+\S/.test(l));
  if (steps.length < 3) {
    errors.push(`Steps section needs at least 3 numbered steps; found ${steps.length}.`);
  }
  const badSteps = steps.filter((l) => IMPERATIVE_BLOCKLIST.test(l.replace(/^\s*\d+[.)]\s*/, "").replace(/^\*+/, "")));
  if (badSteps.length > 0) {
    errors.push(`${badSteps.length} step(s) do not start with an imperative verb. First: "${badSteps[0].trim().slice(0, 70)}"`);
  }

  if (errors.length > 0) {
    return { ok: false, message: `Strict STE failed:\n- ${errors.slice(0, 8).join("\n- ")}` };
  }
  return {
    ok: true,
    message: `Strict STE passed: ${sentences.length} sentences, all <= ${MAX_SENTENCE_WORDS} words, ${steps.length} imperative steps.`,
  };
}

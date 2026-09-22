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

  // "and" joining two imperatives is a compound instruction.
  const compound = sentences.filter((s) => /^[A-Z][a-z]+\b[^.]*\band\b\s+[a-z]+\b/.test(s) && wordCount(s) > 8);
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

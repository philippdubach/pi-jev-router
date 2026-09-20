/**
 * Jev classifier adapter (M1).
 *
 * Uses the TypeSafe SDK pointed at OpenRouter's System One endpoint so the
 * classifier and generative models share one account/key.
 *
 * One overall deadline, no hidden retry cascade (maxRetries: 0).
 * Responses are validated: finite probabilities, expected option keys.
 */
import { readFileSync } from "node:fs";
import { homedir, } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  CLASSIFIER_MODEL,
  CLASSIFIER_TIMEOUT_MS,
  type ClassificationResult,
  type JevAnswer,
  type TaskEnvelope,
} from "./task-envelope.ts";

const OPENROUTER_BASE = "https://openrouter.ai/api"; // SDK appends /v1/systemone

function keyFromPiAuth(): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
    const or = auth?.openrouter;
    return typeof or?.access === "string" ? or.access : undefined;
  } catch {
    return undefined;
  }
}

let client: TypeSafeClient | null = null;

function getClient(): TypeSafeClient | null {
  const apiKey = process.env.OPENROUTER_API_KEY ?? keyFromPiAuth();
  if (!apiKey) return null;
  if (!client) {
    client = new TypeSafeClient({
      apiKey,
      baseURL: OPENROUTER_BASE,
      timeout: CLASSIFIER_TIMEOUT_MS,
      retry: { maxRetries: 0 },
    });
  }
  return client;
}

/** Build the question map. Keys are local ids only — not sent to Jev. */
function buildQuestions(env: TaskEnvelope) {
  return {
    category: {
      type: "choice" as const,
      instructions: "What is the primary nature of this work item?",
      criteria: {
        lookup: "Retrieve or explain existing facts from the supplied context or codebase",
        mechanical_edit: "A fully specified, low-judgment change to existing files",
        implementation: "Write or modify code requiring local design judgment",
        debugging: "Diagnose why current behavior differs from expected behavior",
        architecture: "Design or restructure across components or systems",
        review: "Critically evaluate an existing artifact for correctness or quality",
        unclear: "The objective or supplied context is insufficient to classify",
      },
    },
    complexity: {
      type: "score" as const,
      instructions: "Rate the reasoning difficulty of completing this objective correctly.",
      criteria: [
        "Follow a fully specified mechanical procedure",
        "Apply local judgment within one well-understood component",
        "Diagnose or design across several dependent steps",
        "Resolve substantial ambiguity or cross-system architectural constraints",
      ],
    },
    risk: {
      type: "score" as const,
      instructions: "Rate the impact if the work is done incorrectly.",
      criteria: [
        "Cosmetic or read-only outcome",
        "Reversible local change",
        "Compatibility, data or security-sensitive change",
        "Potentially destructive or externally consequential",
      ],
    },
    brief: {
      type: "choice" as const,
      instructions:
        "Does the objective plus supplied context define enough work to proceed without further input?",
      criteria: {
        sufficient: "Concrete objective and acceptance criteria are supplied",
        inspect: "Objective is clear but repository facts must be gathered first",
        clarify: "A material requirement is ambiguous or missing and a user must decide",
      },
    },
    decompose: {
      type: "noul" as const,
      instructions:
        "Does the objective contain meaningfully separable deliverables that independent sessions should implement?",
    },
  };
}

function finiteProbabilityMap(p: unknown): Record<string, number> | undefined {
  if (!p || typeof p !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
    out[k] = n;
  }
  return out;
}

/** Validate and normalize a raw SDK response into ClassificationResult. */
export function normalizeResponse(
  raw: any,
  startedAt: number,
  requestedModel: string,
): ClassificationResult {
  const answers: Record<string, JevAnswer> = {};
  const rawAnswers = raw?.answers ?? {};
  for (const [id, a] of Object.entries(rawAnswers) as [string, any][]) {
    if (!a || typeof a !== "object") continue;
    const type = a.type as JevAnswer["type"];
    let value: string | number | undefined;
    if (type === "noul") value = Number(a.noul);
    else if (type === "choice") value = String(a.choice ?? "");
    else if (type === "score") value = Number(a.score);
    if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) continue;
    const probs = a.probabilities ? finiteProbabilityMap(a.probabilities) : undefined;
    if (a.probabilities && !probs) continue; // invalid distribution -> drop answer
    answers[id] = {
      id,
      type,
      value,
      probabilities: probs,
      confidence: typeof a.confidence === "number" ? a.confidence : undefined,
    };
  }
  return {
    answers,
    requestedModel,
    resolvedModel: String(raw?.model ?? requestedModel),
    provider: typeof raw?.provider === "string" ? raw.provider : undefined,
    requestId: typeof raw?.id === "string" ? raw.id : undefined,
    usage: raw?.usage
      ? {
          inputTokens: Number(raw.usage.input_tokens) || 0,
          outputTokens: Number(raw.usage.output_tokens) || 0,
          cost: typeof raw.usage.cost === "number" ? raw.usage.cost : undefined,
        }
      : undefined,
    latencyMs: Date.now() - startedAt,
    ok: Object.keys(answers).length > 0,
  };
}

export async function classify(env: TaskEnvelope, signal?: AbortSignal): Promise<ClassificationResult> {
  const startedAt = Date.now();
  const client = getClient();
  if (!client) {
    return {
      answers: {},
      requestedModel: CLASSIFIER_MODEL,
      resolvedModel: CLASSIFIER_MODEL,
      latencyMs: 0,
      ok: false,
      error: "OPENROUTER_API_KEY not set",
      classifierUnavailable: true,
    };
  }
  try {
    const raw = await (client as any).systemOne(
      { model: CLASSIFIER_MODEL, state: env, questions: buildQuestions(env) },
      { signal },
    );
    return normalizeResponse(raw, startedAt, CLASSIFIER_MODEL);
  } catch (err: any) {
    return {
      answers: {},
      requestedModel: CLASSIFIER_MODEL,
      resolvedModel: CLASSIFIER_MODEL,
      latencyMs: Date.now() - startedAt,
      ok: false,
      error: err?.message ?? String(err),
      classifierUnavailable: true,
    };
  }
}

/** Short, bounded task packet for display/log — never full history. */
export function summarizeEnvelope(env: TaskEnvelope): string {
  return `${env.role}: ${env.objective.slice(0, 160)}`;
}
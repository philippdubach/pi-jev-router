/**
 * OpenRouter catalog: fetch, cache, normalise.
 *
 * This module owns every network call and every file read for model data.
 * `src/selector.ts` stays pure and receives the result as an argument.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_CACHE_PATH = join(homedir(), ".pi", "agent", "cache", "openrouter-models.json");

export interface AaIndices {
  intelligence: number;
  coding: number;
  agentic: number;
}

export interface CatalogModel {
  id: string;
  contextLength: number;
  /** USD per input token */
  promptPrice: number;
  /** USD per output token */
  completionPrice: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  inputModalities: string[];
  /** epoch ms, or null when the model does not expire */
  expiresAt: number | null;
  aa: AaIndices | null;
}

/** Verified from the live catalog on 2026-09-20. Used only when the catalog is unreachable. */
export const BOOTSTRAP_MODELS: CatalogModel[] = [
  {
    id: "google/gemini-3.8-flash",
    contextLength: 1048576,
    promptPrice: 0.00000075,
    completionPrice: 0.00000375,
    supportsTools: true,
    supportsReasoning: true,
    inputModalities: ["text", "image", "video", "file", "audio"],
    expiresAt: null,
    aa: { intelligence: 40.9, coding: 76.3, agentic: 40.2 },
  },
  {
    id: "anthropic/claude-sonnet-5",
    contextLength: 1000000,
    promptPrice: 0.000002,
    completionPrice: 0.00001,
    supportsTools: true,
    supportsReasoning: true,
    inputModalities: ["text", "image", "file"],
    expiresAt: null,
    aa: { intelligence: 38.2, coding: 71.5, agentic: 43.6 },
  },
  {
    id: "anthropic/claude-fable-5.1",
    contextLength: 1000000,
    promptPrice: 0.00001,
    completionPrice: 0.00005,
    supportsTools: true,
    supportsReasoning: true,
    inputModalities: ["text", "image", "file"],
    expiresAt: null,
    aa: { intelligence: 53.4, coding: 81.6, agentic: 57.9 },
  },
];

export function normalizeCatalog(raw: unknown): CatalogModel[] {
  const data = (raw as any)?.data;
  if (!Array.isArray(data)) return [];
  const out: CatalogModel[] = [];
  for (const m of data) {
    if (!m || typeof m.id !== "string") continue;
    const ctx = Number(m.context_length);
    if (!Number.isFinite(ctx) || ctx <= 0) continue;
    const params: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const modalities: string[] = Array.isArray(m.architecture?.input_modalities)
      ? m.architecture.input_modalities
      : [];
    const aaRaw = m.benchmarks?.artificial_analysis;
    const expiry = typeof m.expiration_date === "string" ? Date.parse(m.expiration_date) : NaN;
    out.push({
      id: m.id,
      contextLength: ctx,
      promptPrice: Number(m.pricing?.prompt) || 0,
      completionPrice: Number(m.pricing?.completion) || 0,
      supportsTools: params.includes("tools"),
      supportsReasoning: params.includes("reasoning"),
      inputModalities: modalities,
      expiresAt: Number.isFinite(expiry) ? expiry : null,
      aa:
        aaRaw && typeof aaRaw === "object"
          ? {
              intelligence: Number(aaRaw.intelligence_index) || 0,
              coding: Number(aaRaw.coding_index) || 0,
              agentic: Number(aaRaw.agentic_index) || 0,
            }
          : null,
    });
  }
  return out;
}

export interface LoadCatalogOptions {
  now?: number;
  fetchImpl?: typeof fetch;
  cachePath?: string;
}

export interface LoadCatalogResult {
  models: CatalogModel[];
  stale: boolean;
  source: "network" | "cache" | "bootstrap";
}

function readCache(path: string): { fetchedAt: number; models: CatalogModel[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed?.models) || typeof parsed?.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(path: string, models: CatalogModel[], now: number): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: now, models }), "utf8");
  } catch {
    // A cache write failure must not break routing.
  }
}

export async function loadCatalog(opts: LoadCatalogOptions = {}): Promise<LoadCatalogResult> {
  const now = opts.now ?? Date.now();
  const cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
  const doFetch = opts.fetchImpl ?? fetch;

  const cached = readCache(cachePath);
  if (cached && now - cached.fetchedAt < CATALOG_TTL_MS) {
    return { models: cached.models, stale: false, source: "cache" };
  }

  try {
    const res = await doFetch(CATALOG_URL);
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const models = normalizeCatalog(await res.json());
    if (models.length === 0) throw new Error("catalog empty after normalisation");
    writeCache(cachePath, models, now);
    return { models, stale: false, source: "network" };
  } catch {
    if (cached) return { models: cached.models, stale: true, source: "cache" };
    return { models: BOOTSTRAP_MODELS, stale: true, source: "bootstrap" };
  }
}

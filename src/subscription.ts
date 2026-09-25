/**
 * Subscription routing.
 *
 * Selection stays on the frontier and picks a model. This module then asks a
 * separate question: can that same model be reached through a logged-in
 * subscription instead of a metered API route?
 *
 * The frontier is not distorted to prefer subscriptions. Quality and capability
 * decide the model; this only changes how the chosen model is reached.
 *
 * A subscription route is best effort. A ChatGPT account does not support every
 * Codex model, and a plan can hit its usage limit mid-session. Both failures are
 * recorded with a cooldown so the router stops retrying a route that just
 * refused, and falls back to the metered route.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ROUTER_DIR } from "./paths.ts";

export const STATE_DIR = ROUTER_DIR;
export const STATE_FILE = join(STATE_DIR, "subscription-state.json");

/** A refusal is sticky: an unsupported model never becomes supported. */
export const COOLDOWN_UNSUPPORTED_MS = 30 * 24 * 60 * 60 * 1000;
/** A usage limit resets, so retry the route later in the day. */
export const COOLDOWN_LIMIT_MS = 60 * 60 * 1000;
/** Anything else is treated as transient. */
export const COOLDOWN_ERROR_MS = 10 * 60 * 1000;

export type RefusalKind = "unsupported" | "limit" | "error";

export interface Route {
  provider: string;
  modelId: string;
}

export interface SubscriptionState {
  /** `provider/modelId` -> epoch millis until which the route is skipped. */
  blockedUntil: Record<string, number>;
  /** Last refusal reason, kept for `/router status` and the ledger. */
  lastReason: Record<string, string>;
}

function emptyState(): SubscriptionState {
  return { blockedUntil: {}, lastReason: {} };
}

export function loadState(file = STATE_FILE): SubscriptionState {
  try {
    if (!existsSync(file)) return emptyState();
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return {
      blockedUntil: parsed?.blockedUntil ?? {},
      lastReason: parsed?.lastReason ?? {},
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state: SubscriptionState, file = STATE_FILE): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    // Routing must not fail because a cache file could not be written.
  }
}

export function routeKey(route: Route): string {
  return `${route.provider}/${route.modelId}`;
}

/** Classify a provider error so the cooldown matches the cause. */
export function classifyRefusal(message: string): RefusalKind {
  const m = message.toLowerCase();
  if (m.includes("not supported") || m.includes("unsupported")) return "unsupported";
  if (m.includes("usage limit") || m.includes("rate limit") || m.includes("quota") || m.includes("429")) return "limit";
  return "error";
}

export function cooldownFor(kind: RefusalKind): number {
  if (kind === "unsupported") return COOLDOWN_UNSUPPORTED_MS;
  if (kind === "limit") return COOLDOWN_LIMIT_MS;
  return COOLDOWN_ERROR_MS;
}

export function isBlocked(state: SubscriptionState, route: Route, now = Date.now()): boolean {
  const until = state.blockedUntil[routeKey(route)];
  return typeof until === "number" && until > now;
}

export function blockRoute(
  state: SubscriptionState,
  route: Route,
  message: string,
  now = Date.now(),
): SubscriptionState {
  const kind = classifyRefusal(message);
  const key = routeKey(route);
  state.blockedUntil[key] = now + cooldownFor(kind);
  state.lastReason[key] = `${kind}: ${message.replace(/\s+/g, " ").trim().slice(0, 120)}`;
  return state;
}

/**
 * Candidate subscription routes for a metered model id, best first.
 *
 * OpenRouter ids are `vendor/model`. A subscription provider exposes the bare
 * model id. Anthropic ids use dashes where OpenRouter uses dots, so
 * `claude-fable-5.1` becomes `claude-fable-5-1`.
 */
export function candidateRoutes(meteredModelId: string): Route[] {
  const slash = meteredModelId.indexOf("/");
  if (slash < 0) return [];
  const vendor = meteredModelId.slice(0, slash).toLowerCase();
  const bare = meteredModelId.slice(slash + 1);
  if (!bare || bare.includes("/")) return [];

  if (vendor === "openai") {
    // Codex exposes the bare id. Variants such as `:nitro` never match.
    if (/[:@]/.test(bare)) return [];
    return [{ provider: "openai-codex", modelId: bare }];
  }
  if (vendor === "anthropic") {
    if (/[:@]/.test(bare)) return [];
    const dashed = bare.replace(/\./g, "-");
    const routes: Route[] = [{ provider: "anthropic", modelId: dashed }];
    if (dashed !== bare) routes.push({ provider: "anthropic", modelId: bare });
    return routes;
  }
  return [];
}

export interface ResolveOptions {
  /** Provider ids the user has enabled for subscription routing. */
  enabledProviders: string[];
  /** Model ids pi can actually reach, as `provider/id`. */
  availableRoutes: Set<string>;
  state: SubscriptionState;
  now?: number;
}

export interface ResolvedRoute {
  route: Route | null;
  /** Why no subscription route was used, for logging. */
  skipped?: "no_candidate" | "not_enabled" | "not_available" | "cooling_down";
}

/**
 * Pick a usable subscription route for a chosen model, or return null so the
 * caller keeps the metered route.
 */
export function resolveSubscriptionRoute(
  meteredModelId: string,
  opts: ResolveOptions,
): ResolvedRoute {
  const now = opts.now ?? Date.now();
  const candidates = candidateRoutes(meteredModelId);
  if (candidates.length === 0) return { route: null, skipped: "no_candidate" };

  let sawEnabled = false;
  let sawAvailable = false;
  for (const route of candidates) {
    if (!opts.enabledProviders.includes(route.provider)) continue;
    sawEnabled = true;
    if (!opts.availableRoutes.has(routeKey(route))) continue;
    sawAvailable = true;
    if (isBlocked(opts.state, route, now)) continue;
    return { route };
  }
  if (!sawEnabled) return { route: null, skipped: "not_enabled" };
  if (!sawAvailable) return { route: null, skipped: "not_available" };
  return { route: null, skipped: "cooling_down" };
}

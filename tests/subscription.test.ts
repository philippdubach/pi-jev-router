// Subscription routing — run: node --experimental-strip-types tests/subscription.test.ts
import {
  blockRoute, candidateRoutes, classifyRefusal, cooldownFor, isBlocked,
  resolveSubscriptionRoute, COOLDOWN_LIMIT_MS, COOLDOWN_UNSUPPORTED_MS,
  type SubscriptionState,
} from "../src/subscription.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail);
  if (!cond) failed++;
}
const fresh = (): SubscriptionState => ({ blockedUntil: {}, lastReason: {} });

// candidateRoutes
check("openai maps to codex", candidateRoutes("openai/gpt-5.6-terra")[0].provider === "openai-codex");
check("codex keeps the bare id", candidateRoutes("openai/gpt-5.6-terra")[0].modelId === "gpt-5.6-terra");
check("anthropic dots become dashes", candidateRoutes("anthropic/claude-fable-5.1")[0].modelId === "claude-fable-5-1");
check("anthropic keeps a plain id", candidateRoutes("anthropic/claude-sonnet-5")[0].modelId === "claude-sonnet-5");
check("other vendors have no route", candidateRoutes("z-ai/glm-5.3-flash").length === 0);
check("bare ids have no route", candidateRoutes("gpt-5.5").length === 0);
check("routing variants are rejected", candidateRoutes("openai/gpt-5.6-terra:nitro").length === 0);

// classifyRefusal — these strings come from the live probe
check("unsupported model classified", classifyRefusal("The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.") === "unsupported");
check("usage limit classified", classifyRefusal("The usage limit has been reached") === "limit");
check("other errors are transient", classifyRefusal("socket hang up") === "error");
check("unsupported cools down longest", cooldownFor("unsupported") === COOLDOWN_UNSUPPORTED_MS);
check("limit cools down for an hour", cooldownFor("limit") === COOLDOWN_LIMIT_MS);

// blocking
const st = fresh();
const route = { provider: "openai-codex", modelId: "gpt-5.5" };
check("a fresh route is not blocked", !isBlocked(st, route));
blockRoute(st, route, "The usage limit has been reached");
check("a refused route is blocked", isBlocked(st, route));
check("the reason is recorded", (st.lastReason["openai-codex/gpt-5.5"] ?? "").startsWith("limit:"));
check("the block expires", !isBlocked(st, route, Date.now() + COOLDOWN_LIMIT_MS + 1));

// resolveSubscriptionRoute
const available = new Set(["openai-codex/gpt-5.5", "anthropic/claude-sonnet-5"]);
const base = { enabledProviders: ["openai-codex", "anthropic"], availableRoutes: available, state: fresh() };

check("resolves an available route", resolveSubscriptionRoute("openai/gpt-5.5", base).route?.provider === "openai-codex");
check("skips a disabled provider",
  resolveSubscriptionRoute("openai/gpt-5.5", { ...base, enabledProviders: [] }).skipped === "not_enabled");
check("skips a model pi cannot reach",
  resolveSubscriptionRoute("openai/gpt-6-astra", base).skipped === "not_available");
check("skips a vendor with no subscription",
  resolveSubscriptionRoute("z-ai/glm-5.3-flash", base).skipped === "no_candidate");

const cooling = fresh();
blockRoute(cooling, { provider: "openai-codex", modelId: "gpt-5.5" }, "The usage limit has been reached");
const r = resolveSubscriptionRoute("openai/gpt-5.5", { ...base, state: cooling });
check("a cooling route is skipped", r.route === null && r.skipped === "cooling_down");
check("falling back leaves the caller on the metered route", r.route === null);

// Disabled by default: an empty provider list must never route.
check("nothing routes when disabled",
  resolveSubscriptionRoute("anthropic/claude-sonnet-5", { ...base, enabledProviders: [] }).route === null);

process.exit(failed ? 1 : 0);

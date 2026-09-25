// Continuity helpers — run: node --experimental-strip-types tests/continuity.test.ts
import {
  inheritWorkKind, estimateTargetTokens, tokenizerFamily, isSameModel,
  CROSS_TOKENIZER_MARGIN,
} from "../src/continuity.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail);
  if (!cond) failed++;
}

// Continuation inheritance. Prompts taken from a real five-day session.
check("'continue' inherits the previous kind",
  inheritWorkKind("other", "unclear", "continue", "code").workKind === "code");
check("roadmap continuation inherits",
  inheritWorkKind("other", "unclear", "work through the full roadmap", "planning").inherited === true);
check("a classified prompt is not overridden",
  inheritWorkKind("writing", "lookup", "write a short summary", "code").workKind === "writing");
check("a confident non-unclear category is kept",
  inheritWorkKind("other", "lookup", "what time is it", "code").inherited === false);
check("nothing to inherit on the first turn",
  inheritWorkKind("other", "unclear", "continue", undefined).workKind === "other");
check("never inherits other",
  inheritWorkKind("other", "unclear", "continue", "other").inherited === false);
check("a long unclear prompt is not treated as a continuation",
  inheritWorkKind("other", "unclear", Array(20).fill("word").join(" "), "code").inherited === false);
check("a missing category still allows inheritance",
  inheritWorkKind("other", "", "go on", "writing").workKind === "writing");

// Tokenizer families.
check("openrouter id family", tokenizerFamily("openrouter", "deepseek/deepseek-v4.1-flash") === "deepseek");
check("alias prefix stripped", tokenizerFamily("openrouter", "~deepseek/deepseek-flash-latest") === "deepseek");
check("native provider family", tokenizerFamily("anthropic", "claude-opus-5-5") === "anthropic");
check("codex maps to openai", tokenizerFamily("openai-codex", "gpt-5.5") === "openai");
check("openrouter anthropic matches native anthropic",
  tokenizerFamily("openrouter", "anthropic/claude-sonnet-5") === tokenizerFamily("anthropic", "claude-sonnet-5"));

// The real incident: 971,377 DeepSeek tokens counted as 1,429,528 by Anthropic.
const from = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" };
const to = { provider: "anthropic", id: "claude-opus-5-5" };
const est = estimateTargetTokens(971_377, from, to);
check("cross-vendor estimate covers the observed count", est >= 1_429_528, String(est));
check("margin is the documented constant", est === Math.ceil(971_377 * CROSS_TOKENIZER_MARGIN));
check("the guard would now block that switch", est > 1_000_000 * 0.9);
check("same vendor applies no margin",
  estimateTargetTokens(500_000, { provider: "openrouter", id: "anthropic/claude-sonnet-5" }, { provider: "anthropic", id: "claude-sonnet-5" }) === 500_000);
check("non-positive tokens estimate to zero", estimateTargetTokens(0, from, to) === 0 && estimateTargetTokens(NaN, from, to) === 0);

// No-op switch detection.
check("same model detected", isSameModel({ provider: "openrouter", id: "z-ai/glm-5.3-flash" }, { provider: "openrouter", id: "z-ai/glm-5.3-flash" }));
check("different provider is a switch", !isSameModel({ provider: "openrouter", id: "gpt-5.5" }, { provider: "openai-codex", id: "gpt-5.5" }));
check("no current model is a switch", !isSameModel(undefined, { provider: "openrouter", id: "x/y" }));

process.exit(failed ? 1 : 0);

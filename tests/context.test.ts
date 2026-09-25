// Context collector fixtures — run: node --experimental-strip-types tests/context.test.ts
import { collectContext, extractPaths, inferLanguage, readSessionSignals, MAX_CONTEXT_CHARS } from "../src/context.ts";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(cond ? "PASS" : "FAIL", name, cond ? "" : detail);
  if (!cond) failed++;
}

// extractPaths
const paths = extractPaths("fix src/selector.ts and also tests/frontier.test.ts please", process.cwd());
check("extracts real paths", paths.some((p) => p.startsWith("src/selector.ts")), JSON.stringify(paths));
check("marks missing paths", extractPaths("edit src/nope-missing.ts", process.cwd())[0]?.includes("(not found)") === true);
check("ignores urls", extractPaths("see https://example.com/a/b", process.cwd()).length === 0);
check("caps path count", extractPaths(Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`).join(" "), process.cwd()).length <= 8);

// inferLanguage
check("infers dominant language", inferLanguage(["src/a.ts", "src/b.ts", "x.py"]) === "TypeScript");
check("no language without extensions", inferLanguage(["somedir/thing"]) === undefined);

// readSessionSignals
const fakeSession = {
  getBranch: () => [
    { message: { role: "user", content: "first request" } },
    { message: { role: "toolResult", toolName: "read", isError: false } },
    { message: { role: "toolResult", toolName: "bash", isError: true } },
    { message: { role: "user", content: [{ type: "text", text: "second request" }] } },
  ],
};
const sig = readSessionSignals(fakeSession);
check("reads recent turns in order", sig.recentTurns.join("|") === "first request|second request", JSON.stringify(sig.recentTurns));
check("collects tool names", sig.recentTools.includes("read") && sig.recentTools.includes("bash"));
check("records failures", sig.failureKinds.includes("bash_error"));
check("counts attempts", sig.attempt === 1, String(sig.attempt));
check("survives broken session", readSessionSignals({ getBranch: () => { throw new Error("boom"); } }).recentTurns.length === 0);
check("survives missing session", readSessionSignals(undefined).attempt === 0);

// collectContext
const ctx = await collectContext("refactor src/selector.ts to drop the static prior", process.cwd(), {
  sessionManager: fakeSession,
  activeTools: ["read", "edit", "bash"],
  contextTokens: 8123,
  hasImages: false,
});
check("context mentions the file", ctx.relevantContext.includes("src/selector.ts"));
check("context reports git branch", /Git branch: /.test(ctx.relevantContext), ctx.relevantContext);
check("context reports session history", ctx.relevantContext.includes("Earlier requests"));
check("facts carry real token count", ctx.facts.estimatedContextTokens === 8123);
check("facts carry active tools", ctx.facts.requiredTools.includes("edit"));
check("facts carry language", ctx.facts.language === "TypeScript");
check("facts carry failures", ctx.facts.priorFailureKinds.includes("bash_error"));
check("context stays bounded", ctx.relevantContext.length <= MAX_CONTEXT_CHARS, String(ctx.relevantContext.length));

const empty = await collectContext("what does this repo do", process.cwd(), {});
check("handles no-path prompt", empty.relevantContext.includes("names no specific file"));
check("handles no session", empty.relevantContext.includes("first request in the session"));


// --- assistant-side signals ---
const agentic = {
  getBranch: () => [
    { message: { role: "user", content: "fix the escaping in the manuscript" } },
    { message: { role: "assistant", content: [
      { type: "text", text: "Checking caught one real corruption: `\\times` became a tab. Fixing it:" },
      { type: "toolCall", name: "edit", arguments: { path: "/repo/paper/manuscript.tex", edits: [] } },
      { type: "toolCall", name: "bash", arguments: { command: "cd /repo/paper && latexmk -pdf manuscript.tex" } },
    ] } },
    { message: { role: "toolResult", toolName: "edit", isError: false } },
    { message: { role: "user", content: "continue" } },
  ],
};
const ag = readSessionSignals(agentic);
check("captures last assistant text", ag.lastAssistantText?.includes("\\times became a tab") === true, String(ag.lastAssistantText));
check("captures edited file basename", ag.recentPaths.includes("manuscript.tex"), JSON.stringify(ag.recentPaths));
check("captures recent shell command", ag.recentCommands[0]?.includes("latexmk") === true, JSON.stringify(ag.recentCommands));
const agCtx = await collectContext("continue", process.cwd(), { sessionManager: agentic });
check("block leads with work in progress", agCtx.relevantContext.includes("Work in progress"));
check("block names the file", agCtx.relevantContext.includes("manuscript.tex"));
check("block never breaks mid-line", agCtx.relevantContext.split("\n").every((l) => l.length > 0 && !l.endsWith("…") || l.length < 200));

console.log("\n--- sample context block ---\n" + agCtx.relevantContext);
process.exit(failed ? 1 : 0);

/**
 * pi-jev-router — shadow-mode routing extension (M1).
 *
 * On each top-level task: classify with Jev (via OpenRouter System One),
 * recommend a model from a deterministic local policy, and record the
 * decision. Shadow mode NEVER changes the active model.
 *
 * Commands:
 *   /router status   — show mode + last decision
 *   /router shadow   — enable shadow classification
 *   /router off      — disable routing
 *   /router test     — classify a sample task end-to-end
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classify } from "../src/classifier.ts";
import { DEFAULT_POLICY, recommend, type Recommendation } from "../src/selector.ts";
import { record, LEDGER_FILE } from "../src/ledger.ts";
import type { TaskEnvelope, ClassificationResult } from "../src/task-envelope.ts";

type Mode = "shadow" | "off";

export default function (pi: ExtensionAPI) {
  let mode: Mode = "shadow";
  let lastDecision:
    | { ts: string; recommendation: Recommendation; classification?: ClassificationResult; note?: string }
    | undefined;

  const showStatus = (ctx: any) => {
    const m = mode === "shadow" ? "SHADOW (no model changes)" : mode.toUpperCase();
    ctx.ui.setStatus("jev-router", `${m}${lastDecision ? ` · ${lastDecision.recommendation.modelId}` : ""}`);
  };

  pi.on("session_start", async (_event, ctx) => {
    showStatus(ctx);
  });

  // Shadow hook: classify the expanded top-level prompt, recommend, record.
  pi.on("before_agent_start", async (event, ctx) => {
    if (mode !== "shadow") return;
    if (ctx.isIdle() === false && lastDecision && Date.now() - new Date(lastDecision.ts).getTime() < 30_000) {
      // Skip reclassification for steering/follow-ups within a running task.
      return;
    }
    const taskId = `t-${Date.now().toString(36)}`;
    const envelope: TaskEnvelope = {
      taskId,
      role: "direct",
      objective: event.prompt,
      acceptanceCriteria: [],
      relevantContext: "",
      facts: {
        hasImages: (event.images?.length ?? 0) > 0,
        estimatedContextTokens: Math.ceil(event.prompt.length / 4),
        requiredTools: [],
        attempt: 0,
        priorFailureKinds: [],
      },
      policyRef: `policy@v${DEFAULT_POLICY.version}`,
    };

    const classification = await classify(envelope, ctx.signal);
    const recommendation = recommend(
      classification.answers as any,
      DEFAULT_POLICY,
      !classification.classifierUnavailable,
    );
    const note = classification.classifierUnavailable
      ? `classifier unavailable (${classification.error}) — static fallback`
      : undefined;

    lastDecision = { ts: new Date().toISOString(), recommendation, classification, note };
    record({ taskId, mode, recommendation, classification, note });
    showStatus(ctx);

    // Shadow mode: inform, do not switch models.
    const tier = ["cheap", "mid", "strong"][recommendation.tierIndex] ?? `tier${recommendation.tierIndex}`;
    ctx.ui.notify(
      `jev-router (shadow): would route to ${recommendation.modelId} (${tier}, ${recommendation.reason})` +
        (note ? ` — ${note}` : ""),
      "info",
    );
    // No model change in shadow mode.
    return;
  });

  pi.registerCommand("router", {
    description: "Jev router: status | shadow | off | test",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
      switch (sub) {
        case "shadow":
          mode = "shadow";
          showStatus(ctx);
          ctx.ui.notify("jev-router: shadow mode (recommendations only)", "info");
          break;
        case "off":
          mode = "off";
          ctx.ui.setStatus("jev-router", undefined);
          ctx.ui.notify("jev-router: disabled", "info");
          break;
        case "test": {
          const envelope: TaskEnvelope = {
            taskId: `test-${Date.now().toString(36)}`,
            role: "direct",
            objective: "Fix the failing unit test in src/utils/date.test.ts where month parsing is off by one",
            acceptanceCriteria: ["test passes", "no unrelated changes"],
            relevantContext: "",
            facts: { hasImages: false, estimatedContextTokens: 500, requiredTools: ["read", "edit", "bash"], attempt: 0, priorFailureKinds: [] },
            policyRef: `policy@v${DEFAULT_POLICY.version}`,
          };
          const c = await classify(envelope, ctx.signal);
          const r = recommend(c.answers as any, DEFAULT_POLICY, !c.classifierUnavailable);
          ctx.ui.notify(
            `test: ${r.modelId} (${r.reason})` +
              (c.ok ? ` · category=${String((c.answers.category as any)?.value)} complexity=${(c.answers.complexity as any)?.value} risk=${(c.answers.risk as any)?.value}` : ` · ${c.error}`),
            c.ok ? "info" : "warning",
          );
          lastDecision = { ts: new Date().toISOString(), recommendation: r, classification: c };
          record({ taskId: envelope.taskId, mode, recommendation: r, classification: c });
          showStatus(ctx);
          break;
        }
        default: {
          const lines = [
            `mode: ${mode}`,
            lastDecision ? `last: ${lastDecision.recommendation.modelId} (${lastDecision.recommendation.reason})` : "no decision yet",
            `ledger: ${LEDGER_FILE}`,
            `allowlist: ${DEFAULT_POLICY.allowlist.join(", ")}`,
          ];
          ctx.ui.notify(lines.join("\n"), "info");
        }
      }
    },
  });
}
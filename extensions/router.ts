/**
 * pi-jev-router — routing extension (M2: shadow + auto mode).
 *
 * Shadow: classify with Jev (via OpenRouter System One), recommend a model
 * from a deterministic local policy, record the decision. Never switches.
 *
 * Auto: additionally switches the active model via pi.setModel() at
 * task boundaries. Stickiness: one classification per task — steering and
 * follow-ups within a running task are never re-routed. A context-downgrade
 * guard rejects routing to a model whose context window cannot hold the
 * current conversation.
 *
 * Commands:
 *   /router status          — mode + last decision
 *   /router shadow          — recommend only (default)
 *   /router auto            — enable automatic model switching
 *   /router off             — disable
 *   /router pin <model-id>  — pin a concrete model; routing respects pins
 *   /router budget <usd>    — session spend cap for auto mode
 *   /router test            — classify a sample task end-to-end
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classify, WRITING_STYLE_DIRECTIVE } from "../src/classifier.ts";
import { DEFAULT_POLICY, recommend, recommendByRole, resolveWorkKind, PROFILE_MODELS, ROLE_THINKING, type Recommendation, type WorkKind, type RouterProfile } from "../src/selector.ts";
import { record, LEDGER_FILE } from "../src/ledger.ts";
import { createTask, getTask, transition } from "../src/board.ts";
import { dispatch } from "../src/dispatch.ts";
import { Type } from "typebox";
import type { TaskEnvelope, ClassificationResult } from "../src/task-envelope.ts";

type Mode = "shadow" | "auto" | "off";

export default function (pi: ExtensionAPI) {
  let mode: Mode = "shadow";
  let profile: RouterProfile = "pareto_code";
  let pinnedModelId: string | undefined; // explicit /router pin
  let manualPin: string | undefined;     // user's own /model change since last routing
  let sessionBudgetUsd: number | undefined;
  let sessionSpendUsd = 0;
  let inTask = false;                    // stickiness window
  let suppressModelSelect = false;       // guard: our own setModel calls

  let lastDecision:
    | { ts: string; recommendation: Recommendation; classification?: ClassificationResult; note?: string; switched?: boolean }
    | undefined;

  const showStatus = (ctx: any) => {
    const label = mode === "shadow" ? "SHADOW" : mode === "auto" ? "AUTO" : "OFF";
    const prof = mode === "auto" ? `[${profile}]` : "";
    const pin = pinnedModelId ? ` · pinned:${pinnedModelId}` : "";
    const budget = sessionBudgetUsd !== undefined ? ` · $${sessionSpendUsd.toFixed(4)}/$${sessionBudgetUsd}` : "";
    ctx.ui.setStatus(
      "jev-router",
      `${label}${prof}${pin} · ${lastDecision ? lastDecision.recommendation.modelId : "idle"}`,
    );
  };

  const applyMode = (ctx: any) => {
    if (mode === "off") ctx.ui.setStatus("jev-router", undefined);
    else showStatus(ctx);
  };

  pi.on("session_start", async (_event, ctx) => applyMode(ctx));

  // Treat user-driven model changes as a manual pin until /router auto|shadow re-enables routing.
  pi.on("model_select", async (event) => {
    if (suppressModelSelect) return;
    if (event.source === "set" || event.source === "cycle" || event.source === "restore") {
      const id = `${event.model.provider}/${event.model.id}`;
      // Only treat non-openrouter or differing picks as manual pins.
      if (id !== lastDecision?.recommendation.modelId) manualPin = id;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (mode === "off") return;

    // Stickiness: don't reclassify steering/follow-ups mid-task.
    if (event.streamingBehavior) return;

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
    const available = !classification.classifierUnavailable;
    const recommendation = recommend(classification.answers as any, DEFAULT_POLICY, available);
    let note = !available ? `classifier unavailable (${classification.error}) — static fallback` : undefined;

    // Respect pins.
    if (pinnedModelId) recommendation.modelId = pinnedModelId;
    if (manualPin) {
      lastDecision = { ts: new Date().toISOString(), recommendation: { ...recommendation, modelId: manualPin }, note: "manual model pin active" };
      record({ taskId, mode, recommendation: lastDecision.recommendation, classification, note: "manual pin" });
      applyMode(ctx);
      return;
    }

    let switched = false;
    let injectedSystemPrompt: string | undefined;

    if (mode === "auto" && available) {
      // Budget gate.
      const overBudget = sessionBudgetUsd !== undefined && sessionSpendUsd >= sessionBudgetUsd;
      if (overBudget) {
        ctx.ui.notify(`jev-router: session budget $${sessionBudgetUsd} reached — not switching`, "warning");
      } else {
        const category = String((classification.answers as any)?.category?.value ?? "");
        const workKind = resolveWorkKind(undefined, category, event.prompt);

        // Map workKind to its role-specific model and thinking level.
        const roleModel = workKind === "other" ? undefined : PROFILE_MODELS[profile][workKind];
        const roleThinking = workKind === "other" ? undefined : ROLE_THINKING[workKind];
        const target = roleModel ?? recommendation.modelId;
        recommendation.modelId = target;
        recommendation.reason = workKind === "other" ? recommendation.reason : "role_policy";

        const switchedOk = await switchModel(ctx, target, recommendation.tierIndex, roleThinking);
        if (switchedOk === true) switched = true;
        if (switchedOk === undefined) note = `target model unavailable in Pi catalog; restart Pi after configuring ${target}`;

        // Writing tasks get the humanizer + STE style directive injected into the turn.
        if (workKind === "writing") {
          injectedSystemPrompt = (event.systemPrompt ?? "") + WRITING_STYLE_DIRECTIVE;
        }
      }
    }

    // Classifier spend is ours; approximate from its usage.
    if (classification.usage?.cost) sessionSpendUsd += classification.usage.cost;

    lastDecision = { ts: new Date().toISOString(), recommendation, classification, note, switched };
    record({ taskId, mode, recommendation, classification, note: note ?? (switched ? "switched" : "shadow") });
    applyMode(ctx);

    const tier = ["cheap", "mid", "strong"][recommendation.tierIndex] ?? `tier${recommendation.tierIndex}`;
    const verb = switched ? "routed to" : "would route to";
    ctx.ui.notify(
      `jev-router: ${verb} ${recommendation.modelId} (${tier}, ${recommendation.reason})` +
        (note ? ` — ${note}` : ""),
      "info",
    );

    if (injectedSystemPrompt) {
      return { systemPrompt: injectedSystemPrompt };
    }
  });

  async function switchModel(ctx: any, openrouterModelId: string, tierIndex = 1, roleThinking?: string): Promise<boolean | undefined> {
    const current = ctx.model;
    const candidate = (ctx.modelRegistry?.getAvailable?.() ?? []).find(
      (m: any) => m.provider === "openrouter" && m.id === openrouterModelId,
    );
    if (!candidate) {
      // Not available via Pi's OpenRouter provider — never pretend it switched.
      ctx.ui.notify(`jev-router: ${openrouterModelId} is unavailable in Pi's model catalog — staying on ${current?.id ?? "current model"}`, "warning");
      return undefined;
    }
    // Context-downgrade guard: current estimated context must fit target window.
    if (current && candidate.contextWindow && current.usage?.totalTokens) {
      if (current.usage.totalTokens > candidate.contextWindow * 0.9) {
        ctx.ui.notify(
          `jev-router: ${candidate.id} context ${candidate.contextWindow} too small for ~${current.usage.totalTokens} tokens — staying on ${current.id}`,
          "warning",
        );
        return false;
      }
    }
    // Thinking level: role-specific when routed by role, else by tier.
    const level = roleThinking ?? (tierIndex === 0 ? "low" : tierIndex === 1 ? "medium" : "high");
    suppressModelSelect = true;
    try {
      const ok = await pi.setModel(candidate);
      if (ok !== false) pi.setThinkingLevel(level as any);
      return ok !== false;
    } finally {
      suppressModelSelect = false;
    }
  }

  // dispatch_task is available inside every session so the model can
  // delegate implementation subtasks to isolated routed workers.
  pi.registerTool({
    name: "dispatch_task",
    label: "Dispatch Task",
    description:
      "Delegate an implementation or research subtask to an isolated worker session. The worker is routed by role: code -> openrouter/pareto-code, writing -> fast OpenAI, planning -> frontier. Use this to keep your own context clean.",
    promptSnippet: "Delegate an implementation subtask to an isolated routed worker session",
    promptGuidelines: [
      "Use dispatch_task when you have designed a subtask with clear acceptance criteria and want an isolated worker to implement it.",
    ],
    parameters: Type.Object({
      objective: Type.String({ description: "Concrete objective for the worker" }),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { description: "Acceptance checks" })),
      role: Type.Optional(Type.String({ description: "Explicit role: planning | code | writing" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const task = createTask(params.objective);
      const r = await dispatch(task.id, {
        cwd: ctx.cwd,
        acceptanceCriteria: params.acceptanceCriteria ?? [],
        role: params.role,
        signal,
      });
      sessionSpendUsd += r.usage.cost;
      return {
        content: [{
          type: "text",
          text:
            `${task.id}: worker done=${r.ok} model=${r.model} handshake=${r.handshake ? "ok" : "MISSING"}\n` +
            `usage: ${r.usage.turns} turns, in ${r.usage.input}, out ${r.usage.output}, $${r.usage.cost.toFixed(4)}\n` +
            `output: ${r.finalOutput.slice(0, 1500)}` +
            (r.error ? `\nerror: ${r.error}` : "") +
            `\nStatus: ${getTask(task.id)?.status}. Verify independently before accepting.`,
        }],
        details: { taskId: task.id, ...r },
        usage: {
          input: r.usage.input, output: r.usage.output, cacheRead: 0, cacheWrite: 0,
          totalTokens: r.usage.input + r.usage.output,
          cost: { input: r.usage.cost, output: 0, cacheRead: 0, cacheWrite: 0, total: r.usage.cost },
        } as any,
      };
    },
  });

  pi.registerCommand("router", {
    description: "Jev router: status | shadow | auto | off | pin | budget | test",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "status";
      switch (sub) {
        case "shadow":
          mode = "shadow";
          manualPin = undefined;
          applyMode(ctx);
          ctx.ui.notify("jev-router: shadow mode (recommendations only)", "info");
          break;
        case "auto":
          mode = "auto";
          manualPin = undefined;
          applyMode(ctx);
          ctx.ui.notify("jev-router: auto mode — will switch models at task boundaries", "warning");
          break;
        case "off":
          mode = "off";
          applyMode(ctx);
          ctx.ui.notify("jev-router: disabled", "info");
          break;
        case "profile": {
          const p = parts[1] as RouterProfile;
          if (p === "pareto_code" || p === "empirical_cost") {
            profile = p;
            applyMode(ctx);
            ctx.ui.notify(`jev-router: profile set to ${p}`, "info");
          } else {
            ctx.ui.notify(`current profile: ${profile} — usage: /router profile pareto_code | empirical_cost`, "info");
          }
          break;
        }
        case "pin": {
          if (!id) {
            ctx.ui.notify(pinnedModelId ? `pinned: ${pinnedModelId}` : "no pin — usage: /router pin <openrouter-model-id>", "info");
            break;
          }
          pinnedModelId = id;
          applyMode(ctx);
          ctx.ui.notify(`jev-router: pinned to ${id}`, "info");
          break;
        }
        case "budget": {
          const v = Number(parts[1]);
          if (!Number.isFinite(v) || v <= 0) {
            ctx.ui.notify(`budget: ${sessionBudgetUsd !== undefined ? "$" + sessionBudgetUsd : "unset"} · spent $${sessionSpendUsd.toFixed(4)} — usage: /router budget <usd>`, "info");
            break;
          }
          sessionBudgetUsd = v;
          ctx.ui.notify(`jev-router: session budget $${v}`, "info");
          break;
        }
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
          applyMode(ctx);
          break;
        }
        default: {
          const lines = [
            `mode: ${mode} (profile: ${profile})`,
            `pin: ${pinnedModelId ?? "none"} · manual model change: ${manualPin ?? "none"}`,
            `budget: ${sessionBudgetUsd !== undefined ? "$" + sessionBudgetUsd : "unset"} · spent $${sessionSpendUsd.toFixed(4)}`,
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
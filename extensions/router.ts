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
import { selectModel, resolveWorkKind, PROFILE_WEIGHTS, ROLE_THINKING, DECOMPOSE_HINT_THRESHOLD, type Recommendation, type WorkKind } from "../src/selector.ts";
import { loadCatalog, type CatalogModel } from "../src/catalog.ts";
import { loadEvidence, type EvidenceIndex } from "../src/evidence.ts";
import { collectContext } from "../src/context.ts";
import { estimateTargetTokens, inheritWorkKind, isSameModel } from "../src/continuity.ts";
import {
  blockRoute,
  loadState,
  resolveSubscriptionRoute,
  saveState,
  type SubscriptionState,
} from "../src/subscription.ts";
import { record, LEDGER_FILE } from "../src/ledger.ts";
import { createTask, getTask, transition } from "../src/board.ts";
import { dispatch } from "../src/dispatch.ts";
import { Type } from "typebox";
import type { TaskEnvelope, ClassificationResult } from "../src/task-envelope.ts";

type Mode = "shadow" | "auto" | "off";

export default function (pi: ExtensionAPI) {
  let mode: Mode = "shadow";
  /**
   * A bounded auto trial. The default stays shadow; `/router auto --dry-run N`
   * switches models for the next N routed tasks, then returns to shadow and
   * prints what was chosen and at what cost. A trial without a standing
   * commitment is how the router earns the right to stay on.
   */
  let trial: { remaining: number; total: number; log: Array<{ objective: string; model: string; workKind: string; reason: string; costEst?: number }> } | undefined;
  let pinnedModelId: string | undefined; // explicit /router pin
  let manualPin: string | undefined;     // user's own /model change since last routing
  let sessionBudgetUsd: number | undefined;
  let sessionSpendUsd = 0;
  let inTask = false;                    // stickiness window
  let suppressModelSelect = false;       // guard: our own setModel calls

  // Subscription routing. Off unless the user enables a provider, because a
  // plan route can refuse mid-session and silently changing billing is worse
  // than paying the metered rate.
  let subscriptionEnabled: string[] = [];
  let subscriptionState: SubscriptionState = loadState();
  let lastRoutedVia: string | undefined;
  // Last work kind that was not `other`, for continuation prompts.
  let lastWorkKind: WorkKind | undefined;

  let lastDecision:
    | { ts: string; recommendation: Recommendation; classification?: ClassificationResult; note?: string; switched?: boolean }
    | undefined;

  // Catalog and evidence are loaded once, then reused. `selectModel` stays pure.
  let catalogCache: CatalogModel[] = [];
  let catalogSource: "network" | "cache" | "bootstrap" = "bootstrap";
  let evidenceCache: EvidenceIndex = {};

  async function ensureCatalog(): Promise<void> {
    if (catalogCache.length > 0) return;
    const loaded = await loadCatalog();
    catalogCache = loaded.models;
    catalogSource = loaded.source;
    evidenceCache = loadEvidence();
  }

  const showStatus = (ctx: any) => {
    const label = mode === "shadow" ? "SHADOW" : mode === "auto" ? (trial ? `AUTO·dry ${trial.remaining}/${trial.total}` : "AUTO") : "OFF";
    const pin = pinnedModelId ? ` · pinned:${pinnedModelId}` : "";
    const budget = sessionBudgetUsd !== undefined ? ` · $${sessionSpendUsd.toFixed(4)}/$${sessionBudgetUsd}` : "";
    ctx.ui.setStatus(
      "jev-router",
      `${label}${pin} · ${lastDecision ? lastDecision.recommendation.modelId : "idle"}`,
    );
  };

  const applyMode = (ctx: any) => {
    if (mode === "off") ctx.ui.setStatus("jev-router", undefined);
    else showStatus(ctx);
  };

  pi.on("session_start", async (_event, ctx) => applyMode(ctx));

  // A subscription refuses at request time, not at model selection. Watch for
  // the failure, put the route on cooldown and hand the turn back to the user
  // on the metered route.
  pi.on("message_end", async (event, ctx) => {
    const message: any = event.message;
    if (message?.role !== "assistant" || !message.errorMessage) return;
    const provider = message.provider;
    if (!provider || !subscriptionEnabled.includes(provider)) return;
    subscriptionState = blockRoute(subscriptionState, { provider, modelId: message.model }, String(message.errorMessage));
    saveState(subscriptionState);
    ctx.ui.notify(
      `jev-router: ${provider}/${message.model} refused (${String(message.errorMessage).slice(0, 80)}) \u2014 route on cooldown`,
      "warning",
    );
  });

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
    // The classifier can only judge what it receives. Gather bounded session and
    // repository signals instead of sending the bare prompt.
    const collected = await collectContext(event.prompt, ctx.cwd, {
      sessionManager: ctx.sessionManager,
      activeTools: pi.getActiveTools(),
      contextTokens: ctx.getContextUsage()?.tokens,
      hasImages: (event.images?.length ?? 0) > 0,
      contextFiles: event.systemPromptOptions?.contextFiles?.map((f: any) => f.path),
    });
    const envelope: TaskEnvelope = {
      taskId,
      role: "direct",
      objective: event.prompt,
      acceptanceCriteria: [],
      relevantContext: collected.relevantContext,
      facts: collected.facts,
      policyRef: "policy@v3",
    };

    const classification = await classify(envelope, ctx.signal);
    const available = !classification.classifierUnavailable;
    const category = String((classification.answers as any)?.category?.value ?? "");
    // A continuation such as "continue" names no task. Carry the previous
    // classified work kind forward rather than routing it as `other`.
    const inherit = inheritWorkKind(resolveWorkKind(undefined, category, event.prompt), category, event.prompt, lastWorkKind);
    const workKind = inherit.workKind;
    if (workKind !== "other") lastWorkKind = workKind;
    await ensureCatalog();
    // The pick is computed from the live feasible frontier for this task.
    const recommendation = selectModel(envelope, classification, catalogCache, evidenceCache, workKind);
    let note = !available ? `classifier unavailable (${classification.error}) — static fallback` : undefined;

    // Respect pins.
    if (pinnedModelId) recommendation.modelId = pinnedModelId;
    if (manualPin) {
      lastDecision = { ts: new Date().toISOString(), recommendation: { ...recommendation, modelId: manualPin }, note: "manual model pin active" };
      record({ taskId, mode, recommendation: lastDecision.recommendation, classification, note: "manual pin", objective: event.prompt, contextChars: collected.relevantContext.length, contextHead: collected.relevantContext, workKind, inheritedWorkKind: inherit.inherited });
      applyMode(ctx);
      return;
    }

    let switched = false;
    let injectedSystemPrompt: string | undefined;

    // The brief is not ready. Do not switch; the current model is as well
    // placed to ask the clarifying question as any other.
    const abstain = recommendation.reason === "brief_unclear";
    if (abstain) {
      note = `brief not ready (clarify at ${recommendation.briefConfidence?.toFixed(2)}) \u2014 not switching`;
      recommendation.modelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(current)";
    }

    // A task the classifier thinks is separable gets a hint, never an automatic
    // dispatch. Delegating is a behaviour change the user has to see.
    const decomposeP = Number((classification.answers as any)?.decompose?.value ?? 0);
    const suggestDispatch = !abstain && workKind === "code" && decomposeP >= DECOMPOSE_HINT_THRESHOLD;

    if (mode === "auto" && available && !abstain) {
      // Budget gate.
      const overBudget = sessionBudgetUsd !== undefined && sessionSpendUsd >= sessionBudgetUsd;
      if (overBudget) {
        ctx.ui.notify(`jev-router: session budget $${sessionBudgetUsd} reached — not switching`, "warning");
      } else {
        const target = recommendation.modelId;
        const switchedOk = await switchModel(ctx, target, ROLE_THINKING[workKind]);
        if (switchedOk === true) switched = true;
        if (switchedOk === undefined) note = `target model unavailable in Pi catalog; restart Pi after configuring ${target}`;

        // Writing tasks get the humanizer + STE style directive injected into the turn.
        if (workKind === "writing") {
          injectedSystemPrompt = (event.systemPrompt ?? "") + WRITING_STYLE_DIRECTIVE;
        }
      }
    }

    if (suggestDispatch && mode === "auto") {
      injectedSystemPrompt =
        (injectedSystemPrompt ?? event.systemPrompt ?? "") +
        `\n\nThe router judged this task separable (decompose ${decomposeP.toFixed(2)}). ` +
        "If it has independent parts with clear acceptance criteria, consider dispatch_task for them.";
    }

    // Classifier spend is ours; approximate from its usage.
    if (classification.usage?.cost) sessionSpendUsd += classification.usage.cost;

    lastDecision = { ts: new Date().toISOString(), recommendation, classification, note, switched };

    if (trial && mode === "auto" && switched) {
      trial.log.push({ objective: event.prompt.replace(/\s+/g, " ").slice(0, 60), model: recommendation.modelId, workKind, reason: recommendation.reason, costEst: recommendation.cEst });
      trial.remaining -= 1;
      if (trial.remaining <= 0) {
        const lines = trial.log.map((e, i) => `  ${i + 1}. [${e.workKind}] ${e.model} ($${(e.costEst ?? 0).toFixed(4)} est, ${e.reason}) — "${e.objective}"`);
        const spend = trial.log.reduce((a, e) => a + (e.costEst ?? 0), 0);
        mode = "shadow";
        ctx.ui.notify(`jev-router: dry run of ${trial.total} task(s) complete, back to shadow. Estimated spend $${spend.toFixed(4)}.\n${lines.join("\n")}\nRun /router auto to keep it on, or /router auto --dry-run N for another trial.`, "info");
        trial = undefined;
        applyMode(ctx);
      }
    }
    record({
      taskId, mode, recommendation, classification,
      note: note ?? (switched ? "switched" : "shadow"),
      objective: event.prompt,
      contextChars: collected.relevantContext.length,
      contextHead: collected.relevantContext,
      workKind,
      inheritedWorkKind: inherit.inherited,
      candidateCount: recommendation.candidateCount,
      frontierSize: recommendation.frontier?.length,
      q: recommendation.q,
      cEst: recommendation.cEst,
      tEst: recommendation.tEst,
      lambda: recommendation.lambda,
      mu: recommendation.mu,
      reason: recommendation.reason,
    });
    applyMode(ctx);

    const tier = workKind;
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

  async function switchModel(ctx: any, openrouterModelId: string, roleThinking?: string): Promise<boolean | undefined> {
    const current = ctx.model;
    const candidate = (ctx.modelRegistry?.getAvailable?.() ?? []).find(
      (m: any) => m.provider === "openrouter" && m.id === openrouterModelId,
    );
    if (!candidate) {
      // Not available via Pi's OpenRouter provider — never pretend it switched.
      ctx.ui.notify(`jev-router: ${openrouterModelId} is unavailable in Pi's model catalog — staying on ${current?.id ?? "current model"}`, "warning");
      return undefined;
    }
    // Context-downgrade guard. Read the live session size from pi, not from the
    // model object, which carries no usage. Tokens are counted in the current
    // model's tokenizer, so convert before comparing against the target window.
    const liveTokens: number = ctx.getContextUsage?.()?.tokens ?? current?.usage?.totalTokens ?? 0;
    const fits = (m: any): boolean => {
      if (!m?.contextWindow || !liveTokens) return true;
      return estimateTargetTokens(liveTokens, current ?? {}, m) <= m.contextWindow * 0.9;
    };
    if (!fits(candidate)) {
      ctx.ui.notify(
        `jev-router: ${candidate.id} context ${candidate.contextWindow} too small for ~${estimateTargetTokens(liveTokens, current ?? {}, candidate)} tokens in its tokenizer \u2014 staying on ${current?.id}`,
        "warning",
      );
      return false;
    }
    // Thinking level: role-specific, else a safe default.
    const level = roleThinking ?? "medium";

    // Prefer a subscription route to the same model. The frontier already chose
    // the model; this only changes how it is reached. A refusal falls back to
    // the metered route rather than failing the task.
    let target = candidate;
    let routedVia: string | undefined;
    if (subscriptionEnabled.length > 0) {
      const available = new Set<string>(
        (ctx.modelRegistry?.getAvailable?.() ?? []).map((m: any) => `${m.provider}/${m.id}`),
      );
      const resolved = resolveSubscriptionRoute(openrouterModelId, {
        enabledProviders: subscriptionEnabled,
        availableRoutes: available,
        state: subscriptionState,
      });
      if (resolved.route) {
        const subModel = (ctx.modelRegistry?.getAvailable?.() ?? []).find(
          (m: any) => m.provider === resolved.route!.provider && m.id === resolved.route!.modelId,
        );
        if (subModel && fits(subModel)) {
          target = subModel;
          routedVia = resolved.route.provider;
        }
      }
    }

    // Already on the target: set the thinking level and skip the switch, which
    // otherwise writes a model_change entry on every task boundary.
    if (isSameModel(current, target)) {
      pi.setThinkingLevel(level as any);
      lastRoutedVia = routedVia;
      return true;
    }

    suppressModelSelect = true;
    try {
      let ok = await pi.setModel(target);
      if (ok === false && routedVia) {
        // The subscription route refused. Record it and use the metered route.
        subscriptionState = blockRoute(subscriptionState, { provider: target.provider, modelId: target.id }, "setModel refused");
        saveState(subscriptionState);
        ctx.ui.notify(`jev-router: ${routedVia} route refused ${target.id} — using metered route`, "warning");
        routedVia = undefined;
        target = candidate;
        ok = await pi.setModel(target);
      }
      if (ok !== false) {
        pi.setThinkingLevel(level as any);
        lastRoutedVia = routedVia;
      }
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
      verifierCommand: Type.Optional(Type.String({ description: "Automated shell command to verify the worker's changes. If it exits 0, worktree changes merge cleanly. If non-zero, worktree changes are discarded." })),
      isolateWorktree: Type.Optional(Type.Boolean({ description: "Whether to isolate worker in a git worktree (default: true for git repositories)" })),
      role: Type.Optional(Type.String({ description: "Explicit role: planning | code | writing" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const task = createTask(params.objective);
      const r = await dispatch(task.id, {
        cwd: ctx.cwd,
        acceptanceCriteria: params.acceptanceCriteria ?? [],
        verifierCommand: params.verifierCommand,
        isolateWorktree: params.isolateWorktree,
        role: params.role,
        signal,
      });
      sessionSpendUsd += r.usage.cost;
      return {
        content: [{
          type: "text",
          text:
            `${task.id}: worker done=${r.ok} model=${r.model} handshake=${r.handshake ? "ok" : "MISSING"} worktreeIsolated=${r.worktreeIsolated}\n` +
            `usage: ${r.usage.turns} turns, in ${r.usage.input}, out ${r.usage.output}, $${r.usage.cost.toFixed(4)}\n` +
            (r.verificationOutput ? `verification: ${r.verificationOutput}\n` : "") +
            `output: ${r.finalOutput.slice(0, 1500)}` +
            (r.error ? `\nerror: ${r.error}` : "") +
            `\nStatus: ${getTask(task.id)?.status}.`,
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
    description: "Jev router: status | shadow | auto | off | pin | budget | test | frontier",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] || "status";
      const id = parts[1];
      switch (sub) {
        case "shadow":
          mode = "shadow";
          manualPin = undefined;
          applyMode(ctx);
          ctx.ui.notify("jev-router: shadow mode (recommendations only)", "info");
          break;
        case "auto": {
          manualPin = undefined;
          const dry = parts.indexOf("--dry-run");
          if (dry >= 0) {
            const n = Number(parts[dry + 1]);
            if (!Number.isInteger(n) || n < 1 || n > 50) {
              ctx.ui.notify("usage: /router auto --dry-run <1-50>", "warning");
              break;
            }
            trial = { remaining: n, total: n, log: [] };
            mode = "auto";
            applyMode(ctx);
            ctx.ui.notify(`jev-router: dry run — will switch models for the next ${n} routed task(s), then return to shadow with a summary`, "warning");
            break;
          }
          trial = undefined;
          mode = "auto";
          applyMode(ctx);
          ctx.ui.notify("jev-router: auto mode — will switch models at task boundaries", "warning");
          break;
        }
        case "off":
          mode = "off";
          applyMode(ctx);
          ctx.ui.notify("jev-router: disabled", "info");
          break;
        case "pin": {
          if (!id) {
            ctx.ui.notify(pinnedModelId ? `pinned: ${pinnedModelId} — /router pin off releases it` : "no pin — usage: /router pin <openrouter-model-id>", "info");
            break;
          }
          if (id === "off" || id === "none") {
            pinnedModelId = undefined;
            applyMode(ctx);
            ctx.ui.notify("jev-router: pin released", "info");
            break;
          }
          pinnedModelId = id;
          applyMode(ctx);
          ctx.ui.notify(`jev-router: pinned to ${id}`, "info");
          break;
        }
        case "subscription": {
          const arg = (parts[1] ?? "").trim();
          if (arg === "off") {
            subscriptionEnabled = [];
            ctx.ui.notify("jev-router: subscription routing off; all traffic uses the metered route", "info");
            break;
          }
          if (arg) {
            subscriptionEnabled = arg.split(",").map((s) => s.trim()).filter(Boolean);
            ctx.ui.notify(
              `jev-router: subscription routing via ${subscriptionEnabled.join(", ")}. ` +
                "The frontier still picks the model; only the route changes.",
              "warning",
            );
            break;
          }
          const now = Date.now();
          const blocked = Object.entries(subscriptionState.blockedUntil)
            .filter(([, until]) => until > now)
            .map(([key, until]) => `  ${key}: ${subscriptionState.lastReason[key] ?? "blocked"} (${Math.ceil((until - now) / 60000)}m left)`);
          ctx.ui.notify(
            [
              `subscription routing: ${subscriptionEnabled.length ? subscriptionEnabled.join(", ") : "off"}`,
              `last route used: ${lastRoutedVia ?? "metered"}`,
              blocked.length ? `on cooldown:\n${blocked.join("\n")}` : "no routes on cooldown",
              "usage: /router subscription <provider,...> | off",
            ].join("\n"),
            "info",
          );
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
            policyRef: "policy@v2",
          };
          const c = await classify(envelope, ctx.signal);
          const cat = String((c.answers as any)?.category?.value ?? "");
          const wk = resolveWorkKind(undefined, cat, envelope.objective);
          await ensureCatalog();
          const r = selectModel(envelope, c, catalogCache, evidenceCache, wk);
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
        case "frontier": {
          const r = lastDecision?.recommendation;
          if (!r?.frontier?.length) {
            ctx.ui.notify("jev-router: no frontier recorded yet — run a task in auto or shadow mode", "info");
            break;
          }
          const rows = r.frontier
            .slice()
            .sort((a, b) => a.c - b.c)
            .map((m) => `${m.id === r.modelId ? "*" : " "} ${m.id}  q=${m.q.toFixed(3)}  $${m.c.toFixed(4)}  ${Math.round(m.t)}ms`);
          ctx.ui.notify(
            [
              `jev-router frontier (${r.candidateCount} candidates -> ${r.frontier.length} on frontier)`,
              `reason=${r.reason} lambda=${r.lambda} mu=${r.mu}`,
              ...rows,
            ].join("\n"),
            "info",
          );
          break;
        }
        default: {
          const lines = [
            `mode: ${mode}`,
            `pin: ${pinnedModelId ?? "none"} · manual model change: ${manualPin ?? "none"}`,
            `budget: ${sessionBudgetUsd !== undefined ? "$" + sessionBudgetUsd : "unset"} · spent $${sessionSpendUsd.toFixed(4)}`,
            lastDecision ? `last: ${lastDecision.recommendation.modelId} (${lastDecision.recommendation.reason})` : "no decision yet",
            `ledger: ${LEDGER_FILE}`,
            `catalog: ${catalogCache.length} models (${catalogSource})`,
            `weights: ${JSON.stringify(PROFILE_WEIGHTS)}`,
          ];
          ctx.ui.notify(lines.join("\n"), "info");
        }
      }
    },
  });
}
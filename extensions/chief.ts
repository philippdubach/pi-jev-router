/**
 * pi-jev-router — Chief of Staff mode (M3.0).
 *
 * The coordinating session plans, dispatches and verifies; it does not do
 * the implementation. State lives in SQLite (durable board), not in context.
 * Workers are isolated pi processes routed through the Jev tier policy.
 *
 * Commands:
 *   /chief start <objective>   — create task, write brief, dispatch a worker
 *   /chief board [status]      — list tasks
 *   /chief verify <id> <cmd>   — run the verifier command yourself; its exit
 *                                code decides done/failed (reports are intent)
 *   /chief events <id>         — task event log
 *   /chief accept <id>         — accept verifying task -> done
 *
 * Verification discipline: dispatch flips running->verifying at best.
 * Only /chief verify with a real exit code (or accept for non-verifiable
 * tasks) moves a task to done.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createTask, getTask, listTasks, transition, getEvents, reapStale } from "../src/board.ts";
import { dispatch } from "../src/dispatch.ts";

const execFileP = promisify(execFile);

export default function (pi: ExtensionAPI) {
  const showBrief = (ctx: any, text: string) => ctx.ui.notify(text, "info");

  pi.registerCommand("chief", {
    description: "Chief of Staff: start | board | verify | events | accept | cancel",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim();
      const sub = parts.split(/\s+/)[0] || "board";
      const rest = parts.slice(sub.length).trim();
      const cwd = ctx.cwd;

      switch (sub) {
        case "start": {
          if (!rest) { ctx.ui.notify("usage: /chief start <objective>", "warning"); return; }
          const task = createTaskLocal(rest);
          ctx.ui.notify(`chief: created ${task.id} — dispatching worker…`, "info");
          const r = await dispatch(task.id, { cwd, acceptanceCriteria: [] , signal: ctx.signal });
          ctx.ui.notify(
            `chief: ${task.id} worker finished — model=${r.model} handshake=${r.handshake ? "ok" : "MISSING"}\n` +
            `status: ${getStatusLocal(task.id)} · next: /chief verify ${task.id} <check command>`,
            r.ok ? "info" : "warning",
          );
          break;
        }
        case "board": {
          const reaped = reapStale();
          if (reaped.length) ctx.ui.notify(`chief: ${reaped.length} stale task(s) moved to blocked: ${reaped.join(", ")}`, "warning");
          const filter = rest as any;
          const tasks = listTasksLocal(filter && ["queued","ready","running","verifying","done","blocked","failed","cancelled"].includes(filter) ? filter : undefined);
          if (tasks.length === 0) { ctx.ui.notify("chief: board is empty", "info"); break; }
          ctx.ui.notify(tasks.map((t) =>
            `${t.id} [${t.status}]${t.model ? ` ${t.model}` : ""} — ${t.objective.slice(0, 80)}`,
          ).join("\n"), "info");
          break;
        }
        case "verify": {
          const [id, ...cmd] = rest.split(/\s+/);
          const command = cmd.join(" ").trim();
          if (!id || !command) { ctx.ui.notify("usage: /chief verify <task-id> <shell command>", "warning"); break; }
          const t = getTaskLocal(id);
          if (!t) { ctx.ui.notify(`chief: unknown task ${id}`, "error"); break; }
          if (t.status !== "verifying") { ctx.ui.notify(`chief: ${id} is '${t.status}', not verifying — dispatch first`, "warning"); break; }
          ctx.ui.notify(`chief: running verifier: ${command}`, "info");
          try {
            const { stdout, stderr } = await execFileP("bash", ["-c", command], { cwd, timeout: 120_000 });
            const passed = true; // exit 0
            transition(id, "verifying", "done", { verification: `PASS (${command}): ${(stdout || stderr).slice(0, 500)}` });
            ctx.ui.notify(`chief: ${id} VERIFIED — done`, "info");
          } catch (err: any) {
            const code = err?.code ?? err?.killSignal ?? "?";
            transition(id, "verifying", "failed", { verification: `FAIL (${command}) exit=${code}: ${String(err.stdout || err.stderr || err.message).slice(0, 500)}` });
            ctx.ui.notify(`chief: ${id} verification FAILED (exit ${code}) — task marked failed`, "warning");
          }
          break;
        }
        case "accept": {
          const t = getTaskLocal(rest);
          if (!t) { ctx.ui.notify(`chief: unknown task ${rest}`, "error"); break; }
          if (t.status !== "verifying") { ctx.ui.notify(`chief: ${rest} is '${t.status}' (accept only works on verifying)`, "warning"); break; }
          transition(rest, "verifying", "done", { verification: "accepted without command verification (non-verifiable task)" });
          ctx.ui.notify(`chief: ${rest} accepted`, "info");
          break;
        }
        case "cancel": {
          const t = getTaskLocal(rest);
          if (t && transition(rest, null, "cancelled")) ctx.ui.notify(`chief: ${rest} cancelled`, "info");
          else ctx.ui.notify(`chief: cannot cancel ${rest}`, "warning");
          break;
        }
        case "events": {
          const ev = getEventsLocal(rest);
          ctx.ui.notify(ev.length ? ev.map((e) => `${e.ts} ${e.kind}${e.data ? " " + e.data : ""}`).join("\n") : "no events", "info");
          break;
        }
        default:
          showBrief(ctx, "chief: usage /chief start <objective> | board | verify <id> <cmd> | accept <id> | cancel <id> | events <id>");
      }
    },
  });

  // The mandatory dispatch boundary for managed children. Routes every child
  // through the Jev tier policy before spawning an isolated pi worker.
  pi.registerTool({
    name: "dispatch_task",
    label: "Dispatch Task",
    description:
      "Delegate an objective to an isolated worker session. The worker is routed to a model via the Jev tier policy. Use for well-scoped implementation work; you remain responsible for planning and verification.",
    promptSnippet: "Delegate a scoped task to an isolated routed worker session",
    promptGuidelines: [
      "Use dispatch_task when the user asks for a chief/subagent-style split: keep planning and verification yourself, delegate implementation to the worker.",
    ],
    parameters: Type.Object({
      objective: Type.String({ description: "The concrete objective for the worker" }),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { description: "How to verify success" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const task = createTaskLocal(params.objective);
      const r = await dispatch(task.id, {
        cwd: ctx.cwd,
        acceptanceCriteria: params.acceptanceCriteria ?? [],
        signal,
      });
      // Nested usage is returned so pi totals include worker spend.
      return {
        content: [{
          type: "text",
          text:
            `${task.id}: worker done=${r.ok} model=${r.model} handshake=${r.handshake ? "ok" : "MISSING"}\n` +
            `usage: ${r.usage.turns} turns, in ${r.usage.input}, out ${r.usage.output}, $${r.usage.cost.toFixed(4)}\n` +
            `worker output: ${r.finalOutput.slice(0, 1500)}` +
            (r.error ? `\nerror: ${r.error}` : "") +
            `\nBoard status: ${getStatusLocal(task.id)}. Verify independently before accepting (/chief verify ${task.id} <cmd>).`,
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

  // board.ts bindings (indirection keeps the extension importable in tests)
  function createTaskLocal(objective: string) { return createTask(objective); }
  function getTaskLocal(id: string) { return getTask(id); }
  function listTasksLocal(status?: any) { return listTasks(status); }
  function getStatusLocal(id: string) { return getTask(id)?.status ?? "?"; }
  function getEventsLocal(id: string) { return getEvents(id); }
}

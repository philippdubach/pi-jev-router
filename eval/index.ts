import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCHMARK_TASKS } from "./tasks.ts";
import { HARD_TASKS } from "./hard-tasks.ts";
import { CEILING_TASKS } from "./ceiling-tasks.ts";
import { PLANNING_TASKS } from "./planning-tasks.ts";
import { runTaskForStrategy, summarizeStrategy } from "./runner.ts";
import type { RoutingStrategy, TaskRunResult, StrategySummary } from "./types.ts";

async function main() {
  const args = process.argv.slice(2);
  // Default to the two arms the router ships: the fixed baseline and the
  // frontier selector. `--all` adds the pinned role arm as a third control.
  // `--models a,b,c` measures each model directly instead of routing.
  const modelsArg = args.find((a) => a.startsWith("--models="))?.split("=")[1];
  const requestedStrategies: RoutingStrategy[] = modelsArg
    ? modelsArg.split(",").map((m) => `model:${m.trim()}` as RoutingStrategy)
    : args.includes("--all")
    ? ["fixed_frontier", "router_role", "router_frontier"]
    : args.includes("--baseline-only")
    ? ["fixed_frontier"]
    : ["fixed_frontier", "router_frontier"];

  // The original tasks were passed by every model, so they carry no quality
  // signal. `--hard` runs only the discriminating set; `--suite` runs both.
  const pool = args.includes("--planning")
    ? PLANNING_TASKS
    : args.includes("--ceiling")
    ? CEILING_TASKS
    : args.includes("--hard")
      ? [...HARD_TASKS, ...CEILING_TASKS]
      : args.includes("--suite")
        ? [...BENCHMARK_TASKS, ...HARD_TASKS, ...CEILING_TASKS, ...PLANNING_TASKS]
        : BENCHMARK_TASKS;
  const taskFilter = args.find((a) => a.startsWith("--task="))?.split("=")[1];
  const tasksToRun = taskFilter
    ? [...BENCHMARK_TASKS, ...HARD_TASKS, ...CEILING_TASKS, ...PLANNING_TASKS].filter((t) => t.id === taskFilter)
    : pool;

  console.log("========================================================================");
  console.log("  PI JEV ROUTER - STRUCTURED EXECUTION BENCHMARK SUITE");
  console.log("========================================================================");
  console.log(`Tasks: ${tasksToRun.map((t) => t.id).join(", ")}`);
  console.log(`Strategies: ${requestedStrategies.join(", ")}`);
  console.log("------------------------------------------------------------------------\n");

  const allResults: TaskRunResult[] = [];

  for (const strategy of requestedStrategies) {
    console.log(`>>> RUNNING STRATEGY: ${strategy} (${tasksToRun.length} tasks)...`);
    for (const task of tasksToRun) {
      console.log(`\n -> Starting task: [${task.id}] ${task.name}`);
      const result = await runTaskForStrategy(task, strategy);
      allResults.push(result);

      const statusIcon = result.passed ? "PASS" : "FAIL";
      console.log(`    Result: [${statusIcon}] | Time: ${(result.latencyMs / 1000).toFixed(1)}s | Cost: $${result.costUsd.toFixed(5)} | Turns: ${result.turns}`);
      if (!result.passed) {
        console.log(`    Verifier output: ${result.verifierOutput.slice(0, 160)}...`);
      }
    }
    console.log(`\n Strategy ${strategy} completed.\n`);
  }

  // Summary
  console.log("\n========================================================================");
  console.log("  BENCHMARK SUMMARY & COMPARISON");
  console.log("========================================================================");

  const summaries: StrategySummary[] = requestedStrategies.map((s) => summarizeStrategy(s, allResults));

  console.table(
    summaries.map((s) => ({
      Strategy: s.strategy,
      "Pass Rate": `${s.passRate.toFixed(1)}% (${s.passedTasks}/${s.totalTasks})`,
      "Total Cost": `$${s.totalCostUsd.toFixed(4)}`,
      "Cost/Success": `$${s.costPerSuccessUsd.toFixed(4)}`,
      "Avg Latency": `${(s.avgLatencyMs / 1000).toFixed(1)}s`,
      "Total Tokens": s.totalTokens,
    }))
  );

  // Compute savings vs baseline
  const baseline = summaries.find((s) => s.strategy === "fixed_frontier");
  const router = summaries.find((s) => s.strategy === "router_role");

  if (baseline && router && baseline.totalCostUsd > 0) {
    const costSavingsPct = ((baseline.totalCostUsd - router.totalCostUsd) / baseline.totalCostUsd) * 100;
    const costPerSuccessSavingsPct =
      baseline.costPerSuccessUsd > 0
        ? ((baseline.costPerSuccessUsd - router.costPerSuccessUsd) / baseline.costPerSuccessUsd) * 100
        : 0;

    console.log("------------------------------------------------------------------------");
    console.log(`  ROUTER PERFORMANCE VS FIXED FRONTIER BASELINE:`);
    console.log(`  - Total Cost Savings:            ${costSavingsPct.toFixed(1)}%`);
    console.log(`  - Cost per Verified Success:     ${costPerSuccessSavingsPct.toFixed(1)}% savings`);
    console.log(`  - Baseline Pass Rate:            ${baseline.passRate.toFixed(1)}%`);
    console.log(`  - Router Role Pass Rate:         ${router.passRate.toFixed(1)}%`);
    console.log("------------------------------------------------------------------------");
  }

  // Save detailed reports
  const resultsDir = join(process.cwd(), "eval", "results");
  mkdirSync(resultsDir, { recursive: true });
  const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(resultsDir, `benchmark-${dateStr}.json`);
  const mdPath = join(resultsDir, `benchmark-report-${dateStr}.md`);

  writeFileSync(jsonPath, JSON.stringify({ summaries, results: allResults }, null, 2), "utf8");

  const mdReport = generateMarkdownReport(summaries, allResults);
  writeFileSync(mdPath, mdReport, "utf8");

  console.log(`\nSaved structured benchmark reports:`);
  console.log(`- JSON:     ${jsonPath}`);
  console.log(`- Markdown: ${mdPath}`);
}

function generateMarkdownReport(summaries: StrategySummary[], results: TaskRunResult[]): string {
  const lines: string[] = [
    "# Pi Jev Router: Benchmark & Verification Report",
    "",
    `**Generated:** ${new Date().toISOString()}`,
    "",
    "## 1. Executive Summary",
    "",
    "| Strategy | Pass Rate | Total Cost | Cost / Success | Avg Latency | Total Tokens |",
    "|---|---|---|---|---|---|",
  ];

  for (const s of summaries) {
    lines.push(
      `| \`${s.strategy}\` | ${s.passRate.toFixed(1)}% (${s.passedTasks}/${s.totalTasks}) | $${s.totalCostUsd.toFixed(4)} | $${s.costPerSuccessUsd.toFixed(4)} | ${(s.avgLatencyMs / 1000).toFixed(1)}s | ${s.totalTokens} |`
    );
  }

  lines.push("", "## 2. Per-Task Execution Breakdown", "");
  lines.push("| Task | Strategy | Model Used | Thinking | Passed | Cost ($) | Latency (s) |", "|---|---|---|---|---|---|---|");

  for (const r of results) {
    lines.push(
      `| \`${r.taskId}\` | \`${r.strategy}\` | \`${r.modelUsed}\` | ${r.thinkingUsed} | ${r.passed ? "PASS" : "FAIL"} | $${r.costUsd.toFixed(5)} | ${(r.latencyMs / 1000).toFixed(1)} |`
    );
  }

  lines.push("", "## 3. Verifier Notes & Observations", "");
  for (const r of results) {
    lines.push(`### Task \`${r.taskId}\` under \`${r.strategy}\``);
    lines.push(`- **Model:** \`${r.modelUsed}\` (thinking: ${r.thinkingUsed})`);
    lines.push(`- **Status:** ${r.passed ? "PASS" : "FAIL"}`);
    lines.push(`- **Verifier Output:** \n\`\`\`\n${r.verifierOutput.trim()}\n\`\`\``);
    if (r.error) {
      lines.push(`- **Error:** ${r.error}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

main().catch((err) => {
  console.error("Benchmark runner failed:", err);
  process.exit(1);
});

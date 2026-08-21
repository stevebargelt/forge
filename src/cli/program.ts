import { Command } from "commander";
import { version } from "../../package.json" with { type: "json" };
import { registerNew } from "./commands/new.js";
import { registerNext } from "./commands/next.js";
import { registerGate } from "./commands/gate.js";
import { registerShow } from "./commands/show.js";
import { registerStatus } from "./commands/status.js";
import { registerAuth } from "./commands/auth.js";
import { registerAuthProfile } from "./commands/auth-profile.js";
import { registerAdvise } from "./commands/advise.js";
import { registerRetry } from "./commands/retry.js";
import { registerInit } from "./commands/init.js";
import { registerWatch } from "./commands/watch.js";
import { registerLaunch } from "./commands/launch.js";
import { registerCiWaitCommand } from "./commands/ci-wait.js";
import { registerUpgrade } from "./commands/upgrade.js";
import { registerInvoke } from "./commands/invoke.js";
import { registerContinue } from "./commands/continue.js";
import { registerLostSignals } from "./commands/lost-signals.js";
import { registerContinuation } from "./commands/continuation.js";
import { registerBacklog } from "./commands/backlog.js";
import { registerQueue } from "./commands/queue.js";
import { registerBacklogMigrate } from "./commands/backlog-migrate.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerNotify } from "./commands/notify.js";
import { registerProjects } from "./commands/projects.js";
import { registerUsage } from "./commands/usage.js";
import { registerRuns } from "./commands/runs.js";
import { registerMetrics } from "./commands/metrics.js";
import { registerBundle } from "./commands/bundle.js";
import { registerExport } from "./commands/export.js";
import { registerReport } from "./commands/report.js";
import { registerSweep } from "./commands/sweep.js";
import { registerCancel } from "./commands/cancel.js";
import { registerRecover } from "./commands/recover.js";
import { registerClaude } from "./commands/claude.js";
import { registerOrchestrator } from "./commands/orchestrator.js";
import { registerDesign } from "./commands/design.js";
import { registerModel } from "./commands/model.js";
import { registerProviders } from "./commands/providers.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerSetup } from "./commands/setup.js";
import { registerOps } from "./commands/ops.js";
import { registerOrient } from "./commands/orient.js";
import { registerDependencyCache } from "./commands/dependency-cache.js";
import { registerRaci } from "./commands/raci.js";
import { registerPi } from "./commands/pi.js";
import { registerReview } from "./commands/review.js";
import { registerReviewLoop } from "./commands/review-loop.js";
import { registerRoute } from "./commands/route.js";
import { registerCheckAgentDiff } from "./commands/check-agent-diff.js";
import { registerCampaign } from "./commands/campaign.js";
import { registerReadiness } from "./commands/readiness.js";
import { registerRecordHostVerification } from "./commands/record-host-verification.js";
import { registerPublish } from "./commands/publish.js";
import { registerStore } from "./commands/store.js";
import { registerBackup } from "./commands/backup.js";
import { registerRelease } from "./commands/release.js";
import { loadNotifyEnv } from "../notify/load-env.js";

// FG-552: the full command registry lives here, imported LAZILY by src/cli/index.ts
// only for commands that are NOT the minimal `launch wait` observer. Statically
// importing every command module (and thereby better-sqlite3) is exactly what the
// F33 fast path in index.ts avoids for the observer path.
export function buildProgram(): Command {
  // Populate process.env from ~/.forge/notify.env before any command runs. Shell
  // env vars win over the file (file is fallback, not override). Silent no-op
  // if the file doesn't exist — opt-in by creating it.
  loadNotifyEnv();

  const program = new Command();
  program
    .name("forge")
    .description("Multi-agent workflow orchestrator")
    .version(version)
    // Required for `forge claude` to passThroughOptions (i.e. forward unknown
    // flags like --continue / --model / --add-dir straight to the `claude`
    // binary). Affects only commands that opt into passThroughOptions; others
    // parse normally.
    .enablePositionalOptions();

  registerNew(program);
  registerNext(program);
  registerGate(program);
  registerShow(program);
  registerStatus(program);
  registerAuth(program);
  registerAuthProfile(program);
  registerAdvise(program);
  registerRetry(program);
  registerInit(program);
  registerWatch(program);
  registerLaunch(program);
  registerCiWaitCommand(program);
  registerUpgrade(program);
  registerInvoke(program);
  registerContinue(program);
  registerLostSignals(program);
  registerContinuation(program);
  registerBacklog(program);
  registerQueue(program);
  registerBacklogMigrate(program);
  registerDashboard(program);
  registerNotify(program);
  registerProjects(program);
  registerUsage(program);
  registerRuns(program);
  registerMetrics(program);
  registerBundle(program);
  registerExport(program);
  registerReport(program);
  registerSweep(program);
  registerCancel(program);
  registerRecover(program);
  registerClaude(program);
  registerOrchestrator(program);
  registerDesign(program);
  registerModel(program);
  registerProviders(program);
  registerDoctor(program);
  registerSetup(program);
  registerOps(program);
  registerOrient(program);
  registerDependencyCache(program);
  registerRaci(program);
  registerPi(program);
  registerReview(program);
  registerReviewLoop(program);
  registerRoute(program);
  registerCheckAgentDiff(program);
  registerCampaign(program);
  registerReadiness(program);
  registerRecordHostVerification(program);
  registerPublish(program);
  registerStore(program);
  registerBackup(program);
  registerRelease(program);

  return program;
}

export async function runForge(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

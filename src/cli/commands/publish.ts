// FG-425 operator surface: the publication lane and the durable per-attempt
// record. An attempt that is queued, holding, or parked must be VISIBLE — a
// serialized publisher that gives the operator no way to see who is in front of
// them is indistinguishable from a hung one.

import type { Command } from "commander";
import {
  activeLaneForProject,
  allLaneEntries,
  allPublicationAttempts,
  getPublicationAttempt,
  laneForProject,
  publicationAttemptsForProject,
  publicationMutexHolder,
  storeNowMs,
  type LaneEntry,
  type PublicationAttempt,
} from "../../store/publications.js";
import { projectIdentity } from "../../v2/project-identity.js";
import { recoverPublicationByHand } from "../../v2/runNext.js";
import { publicationAfterCancelMessage } from "./show.js";

function sha(s: string | undefined): string {
  return s ? s.slice(0, 12) : "—";
}

function laneLine(e: LaneEntry, nowMs: number): string {
  const lease =
    e.state === "queued" || e.state === "holding"
      ? ` lease ${Math.round((e.leaseExpiresAtMs - nowMs) / 1000)}s`
      : "";
  const mark = e.state === "holding" ? "▶" : e.state === "queued" ? " " : "·";
  return `  ${mark} #${e.enqueueSeq}  ${e.state.padEnd(9)} ${e.attemptId}  run ${e.runId}${lease}`;
}

function attemptLines(a: PublicationAttempt): string[] {
  const out = [
    `  ${a.attemptId}  ${a.state}${a.parkReason ? ` (${a.parkReason})` : ""}`,
    `    run ${a.runId}  task ${a.taskId}`,
    `    target       ${a.target}`,
    `    baseSha      ${sha(a.baseSha)}`,
    `    candidateSha ${sha(a.candidateSha)}`,
    `    publishedSha ${sha(a.publishedSha)}`,
  ];
  if (a.rebuildCount > 0) out.push(`    rebuilds     ${a.rebuildCount}`);
  if (a.worktreePath) out.push(`    worktree     ${a.worktreePath}`);
  return out;
}

export function registerPublish(program: Command): void {
  const publish = program
    .command("publish")
    .description("Inspect the serialized integration publisher (FG-425): the FIFO lane and publication attempts");

  publish
    .command("lane")
    .description("Show the FIFO publication lane, in durable enqueue order")
    .option("-p, --project <dir>", "project directory (canonicalized); defaults to every project")
    .option("-a, --all", "include terminal (done/abandoned) entries")
    .option("--json", "emit the lane, the window holder and the store clock as JSON")
    .action((opts: { project?: string; all?: boolean; json?: boolean }) => {
      const nowMs = storeNowMs();
      if (opts.project) {
        const { key, canonicalDir } = projectIdentity(opts.project);
        const entries = opts.all ? laneForProject(key) : activeLaneForProject(key);
        const holder = publicationMutexHolder(key);
        if (opts.json) {
          console.log(
            JSON.stringify({ nowMs, projectKey: key, canonicalDir, holder: holder ?? null, entries }, null, 2),
          );
          return;
        }
        console.log(`lane for ${canonicalDir}`);
        if (holder) {
          console.log(
            `  publication window HELD by run ${holder.runId} (attempt ${holder.attemptId}) — CAS + fast-forward only`,
          );
        }
        if (entries.length === 0) {
          console.log("  (empty)");
          return;
        }
        for (const e of entries) console.log(laneLine(e, nowMs));
        return;
      }
      const all = allLaneEntries().filter((e) => opts.all || e.state === "queued" || e.state === "holding");
      if (opts.json) {
        // No project means no single window to name: the holder is per-project, and
        // reporting one project's holder against every project's lane would be a lie.
        console.log(JSON.stringify({ nowMs, entries: all }, null, 2));
        return;
      }
      if (all.length === 0) {
        console.log("no publication lane entries");
        return;
      }
      for (const e of all) console.log(laneLine(e, nowMs));
    });

  publish
    .command("attempts")
    .description("Show the durable {baseSha, candidateSha, publishedSha, target} record per publication attempt")
    .option("-p, --project <dir>", "project directory (canonicalized); defaults to every project")
    .option("--json", "emit the durable per-attempt record as JSON")
    .action((opts: { project?: string; json?: boolean }) => {
      const attempts = opts.project
        ? publicationAttemptsForProject(projectIdentity(opts.project).key)
        : allPublicationAttempts();
      if (opts.json) {
        console.log(JSON.stringify({ attempts }, null, 2));
        return;
      }
      if (attempts.length === 0) {
        console.log("no publication attempts");
        return;
      }
      for (const a of attempts) {
        for (const line of attemptLines(a)) console.log(line);
        console.log("");
      }
    });

  publish
    .command("recover <attemptId>")
    .description(
      "Re-derive a publication attempt's outcome from {baseSha, candidateSha, currentTargetSha} and converge it (AD-5), then reconcile the task that owns it. Idempotent.",
    )
    .action((attemptId: string) => {
      const before = getPublicationAttempt(attemptId);
      if (!before) {
        console.error(`forge: no publication attempt ${attemptId}`);
        process.exitCode = 1;
        return;
      }
      // Recovery mutates the target's working tree and the attempt record, so it
      // goes through the publication mutex like every other target write — or it
      // refuses, naming the live holder. Never bare: a hand-run recovery inside
      // someone else's CAS window is two processes in one working tree.
      //
      // Both halves, or this command settles the publication and leaves the task that
      // owns it stuck in `awaiting_recovery`: converge the attempt, then reconcile the
      // task from it — the same reconciliation `forge next` runs.
      const { outcome, task, unreconciled, publishedAfterCancel } = recoverPublicationByHand(attemptId);
      if (outcome.kind === "blocked") {
        console.error(outcome.error);
        process.exitCode = 1;
        return;
      }
      console.log(`attempt ${attemptId}: ${outcome.kind}`);
      if (outcome.kind === "published") {
        console.log(`  published ${outcome.publishedSha} to ${outcome.target}`);
        if (outcome.superseded) {
          // The ref moved PAST this candidate: it landed, and a later publication
          // built on top of it. Say so, or "published" beside a target ref that
          // isn't this SHA reads like a contradiction.
          console.log(
            `  (superseded: the target ref has since moved past ${outcome.publishedSha.slice(0, 12)} — this ` +
              `candidate IS in the target's history; a later publication built on top of it. Nothing to re-run.)`,
          );
        }
        if (outcome.checkoutError) {
          // The ref carries the candidate, so the publication IS durable — but the
          // checked-out tree could not be brought up to it. Say both things, or the
          // operator reads "published" and never looks at their working tree.
          console.error(
            `  WARNING: the publication is durable (the ref carries ${outcome.publishedSha.slice(0, 12)}), but ` +
              `${attemptId}'s checked-out working tree could NOT be updated to it:\n    ${outcome.checkoutError}\n` +
              `  Resolve the working-tree state (an untracked file is usually in the way) and re-run this command — ` +
              `it is idempotent.`,
          );
          process.exitCode = 1;
        }
      } else if (outcome.kind === "parked") {
        console.log(`  ${outcome.reason}: ${outcome.error}`);
      } else if (outcome.kind === "refused") {
        console.log(`  ${outcome.error}`);
      }
      if (task) {
        console.log(`  task ${task.taskId} (run ${task.runId}) reconciled onto it: ${task.status}`);
      }
      // FG-425: the task was cancelled and its candidate landed anyway. Recovery
      // settles the publication and leaves the cancel standing — say both, or an
      // operator reads "published" and never learns their cancel did not stop it.
      if (publishedAfterCancel) {
        const a = getPublicationAttempt(attemptId)!;
        console.log(`  task ${publishedAfterCancel.taskId} (run ${publishedAfterCancel.runId}) was CANCELLED and stays cancelled — NOT reconciled onto this publication.`);
        console.log(`  ${publicationAfterCancelMessage(a)}`);
      }
      if (unreconciled) {
        console.error(`  WARNING: ${unreconciled}`);
      }
    });
}

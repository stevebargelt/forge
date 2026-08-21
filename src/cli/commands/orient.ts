import type { Command } from "commander";
import { resolve } from "node:path";
import { buildOrientSnapshot, type OrientSnapshot } from "../../orient/snapshot.js";

// FG-588: `forge orient snapshot` — the ONE compact, read-only Forge-owned state
// projection that ordinary `/orient` runs instead of seven unconditional bulk
// reads. `--json` is the machine surface the operator adapter consumes; the human
// render is a courtesy for a direct terminal run. Both are side-effect-free.

export function renderHuman(s: OrientSnapshot): string {
  const lines: string[] = [];
  const p = s.project;
  const live = p.liveSessions > 0 ? `, ${p.liveSessions} live session(s)` : "";
  const flight = p.inFlight > 0 ? `, ${p.inFlight} in-flight` : "";
  lines.push(`Project: ${p.name} (${p.path})${live}${flight}`);
  if (p.lastActivity) lines.push(`Last activity: ${p.lastActivity}`);

  if (s.handoff.present) {
    if (s.handoff.whereWeLeftOff) lines.push(`Where we left off: ${s.handoff.whereWeLeftOff.text}`);
    if (s.handoff.pickedUpNext) lines.push(`Picked up next: ${s.handoff.pickedUpNext.text}`);
    if (s.handoff.stale) lines.push(`Handoff is STALE — no "Picked up next" section.`);
  } else {
    lines.push(`No handoff notes.`);
  }

  const at = s.activeTickets;
  lines.push(`Active tickets: ${at.count}${at.truncated ? ` (showing ${at.ids.length})` : ""}${at.ids.length ? ` — ${at.ids.slice(0, 3).join(", ")}` : ""}`);

  for (const ref of s.referencedTickets.refs) {
    lines.push(`  ref ${ref.id}: ${ref.status}${ref.title ? ` — ${ref.title}` : ""}`);
  }
  if (s.referencedTickets.truncated) {
    lines.push(`  … ${s.referencedTickets.count} referenced ticket(s) total, showing ${s.referencedTickets.refs.length} — drill in for the rest`);
  }

  if (s.ops.total > 0) {
    const by = s.ops.bySeverity;
    lines.push(`Ops: ${s.ops.total} incident(s) (high ${by.high} / medium ${by.medium} / low ${by.low})`);
    for (const inc of s.ops.highestSeverity) {
      lines.push(`  [${inc.severity}] ${inc.kind} (${inc.runId}${inc.taskId ? ` / ${inc.taskId}` : ""})`);
    }
    if (s.ops.truncated) lines.push(`  … drill in with \`forge ops check --json\` for the rest`);
  }
  return lines.join("\n");
}

export function registerOrient(program: Command): void {
  const orient = program
    .command("orient")
    .description("Start-of-session orientation state for a forge orchestrator.");

  orient
    .command("snapshot")
    .description(
      "Emit the compact, bounded, read-only state-of-play a /orient session needs: project liveness, bounded " +
        "handoff fields, active-ticket count + a capped identity set, exact status for tickets referenced by " +
        "'Picked up next', and an ops summary (counts + a bounded highest-severity identity set, no evidence). " +
        "Side-effect-free."
    )
    .option("--json", "emit the snapshot as JSON")
    .option("--project <dir>", "project directory (default: cwd)")
    .action((opts: { json?: boolean; project?: string }) => {
      const projectDir = resolve(opts.project ?? process.cwd());
      const snapshot = buildOrientSnapshot(projectDir);
      if (opts.json) {
        console.log(JSON.stringify(snapshot));
        return;
      }
      console.log(renderHuman(snapshot));
    });
}

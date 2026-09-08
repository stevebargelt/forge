import type { Command } from "commander";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { assetRoot } from "../../v2/asset-root.js";
import { assertDashboardClosure } from "../../v2/release.js";
import {
  getConflict,
  listOpenConflicts,
  listProjectionMap,
  resolveConflict,
  type KanbanConflict,
  type ProjectionMapRow,
} from "../../store/kanban-projection.js";

// FG-785 (external kanban projection, OUTBOUND-ONLY): the operator CLI surface. Four
// host-operator verbs project Forge planning ONE-WAY onto an external kanban board and
// inspect/resolve the durable state the outbound sync records:
//
//   forge kanban sync              — run an outbound, one-way projection of a project's board.
//   forge kanban status            — list the durable Forge->external-card projection map.
//   forge kanban conflicts         — list OPEN external-change conflicts (both versions recorded).
//   forge kanban conflicts-resolve — record the AUTHORIZED resolution that closes a conflict.
//
// SCOPE (deliberate, per PLAN.md): OUTBOUND ONLY. One-way projection is the default and the ONLY
// mode. NO inbound planning actions are enabled this release — nothing here (or in the entry `sync`
// shells into) applies an external change back to Forge. Inbound is a later addition that must ride
// FG-783's authenticated, revision-bound planning-command contract.
//
// LAYERING. `sync` SHELLS into the dashboard-workspace entry (dashboard/src/kanban/cli-entry.ts)
// exactly as `forge dashboard` shells into dashboard/src/server.ts: the FG-781 projection
// (assembleRemoteBoard + the to* mappers) is dashboard-workspace-internal, so the core CLI hands
// off rather than inverting the package layering. `status`, `conflicts` and `conflicts-resolve` are
// core->core: they import the src/store/kanban-projection.ts accessors directly — no dashboard dep —
// to read the map/conflict tables and perform the authorized store-write resolution.
//
// CREDENTIALS. This core surface NEVER reads a provider credential. `sync` forwards the host
// environment verbatim to the entry, which reads the credential AT THE EDGE (readProviderCredential)
// and drops it — the credential never reaches a persisted row, a log line, or this CLI's output.
// Resolution is host-operator only: `conflicts-resolve` is the ONLY path that closes a conflict, and
// it is a local store write — never a remote/browser action.

/** The one-way / no-inbound guarantee, printed on the group help and on `sync` help so an operator
 *  reading either sees it. Kept as one constant so the two help surfaces cannot drift. */
const ONE_WAY_NOTE = [
  "",
  "One-way outbound projection is the DEFAULT and the only mode in this release.",
  "NO inbound planning actions are enabled: an external board change is never applied back to",
  "Forge — it is recorded as a conflict (see `forge kanban conflicts`) and resolved only by an",
  "authorized host operator via `forge kanban conflicts-resolve`. Inbound sync is a later,",
  "FG-783-bound addition and ships no write path here.",
].join("\n");

/** Resolve the runnable dashboard-workspace kanban entry the core `sync` shells into. Mirrors
 *  src/cli/commands/dashboard.ts: resolution is RELEASE-OWNED (assetRoot() — the tree this binary
 *  executes from, dev checkout or promoted release), never the invocation cwd or an ambient
 *  FORGE_REPO_DIR, and a torn/incomplete release fails NAMED and NONZERO via assertDashboardClosure
 *  rather than silently projecting nothing. */
export function resolveKanbanEntry(): { dashboardDir: string; entry: string } {
  const root = assetRoot();
  assertDashboardClosure(root);
  const dashboardDir = join(root, "dashboard");
  const entry = join(dashboardDir, "src", "kanban", "cli-entry.ts");
  return { dashboardDir, entry };
}

function printProjectionMap(rows: ProjectionMapRow[]): void {
  if (rows.length === 0) {
    console.log("No cards have been projected for this project/provider yet.");
    return;
  }
  console.log(`${rows.length} projected card(s):`);
  for (const row of rows) {
    console.log(
      `  ${row.ticketIdentity}  [${row.projectionState}]  card=${row.externalCardId}  ` +
        `hash=${row.lastProjectedHash.slice(0, 12)}  by=${row.projectedBy}  at=${row.projectedAt}`,
    );
  }
}

function printConflicts(conflicts: KanbanConflict[]): void {
  if (conflicts.length === 0) {
    console.log("No open conflicts.");
    return;
  }
  console.log(`${conflicts.length} open conflict(s) — resolve with \`forge kanban conflicts-resolve <id>\`:`);
  for (const c of conflicts) {
    console.log(
      `  ${c.id}  ${c.kind}  ticket=${c.ticketIdentity}  provider=${c.provider}  ` +
        `card=${c.externalCardId}  detected=${c.detectedAt} by ${c.detectedBy}`,
    );
  }
}

export function registerKanban(program: Command): void {
  const kanban = program
    .command("kanban")
    .description(
      "Project Forge planning ONE-WAY onto an external kanban board (outbound only; NO inbound " +
        "planning actions are enabled this release).",
    )
    .addHelpText("after", ONE_WAY_NOTE);

  // Bare `forge kanban` (no subcommand): show help.
  kanban.action(() => {
    kanban.help();
  });

  // ─── sync (shells into the dashboard entry) ──────────────────────────────────────
  kanban
    .command("sync")
    .description(
      "Run an OUTBOUND, one-way projection of a project's board onto the external provider. " +
        "Outbound only — never writes an external change back to Forge.",
    )
    .requiredOption("--project <key>", "opaque Forge project key to project")
    .option(
      "--provider <name>",
      "external provider name (default: fake — the only reference provider that ships this release)",
      "fake",
    )
    .addHelpText("after", ONE_WAY_NOTE)
    .action((opts: { project: string; provider: string }) => {
      const { dashboardDir, entry } = resolveKanbanEntry();

      // Shell into the dashboard entry under THIS process's interpreter, cwd=<dashboard> so tsx
      // discovers dashboard/tsconfig.json and the `@forge/*` paths resolve at runtime — the SAME
      // pattern as `forge dashboard start`. The host env is forwarded VERBATIM: the entry reads the
      // provider credential at the edge; this core CLI never reads or logs it.
      const child = spawn(
        process.execPath,
        ["--import", "tsx", entry, "--project", opts.project, "--provider", opts.provider],
        { stdio: "inherit", cwd: dashboardDir, env: { ...process.env } },
      );
      child.on("exit", (code) => process.exit(code ?? 0));
    });

  // ─── status (core->core: read the projection map) ────────────────────────────────
  kanban
    .command("status")
    .description("List the durable Forge->external-card projection map for a project/provider (read-only).")
    .requiredOption("--project <key>", "opaque Forge project key")
    .option("--provider <name>", "external provider name (default: fake)", "fake")
    .option("--json", "emit the structured result as JSON")
    .action((opts: { project: string; provider: string; json?: boolean }) => {
      const rows = listProjectionMap(opts.project, opts.provider);
      if (opts.json) {
        console.log(
          JSON.stringify({ project: opts.project, provider: opts.provider, count: rows.length, cards: rows }, null, 2),
        );
        return;
      }
      console.log(`kanban projection map — project=${opts.project} provider=${opts.provider} (one-way, outbound only)`);
      printProjectionMap(rows);
    });

  // ─── conflicts (core->core: list OPEN conflicts) ─────────────────────────────────
  kanban
    .command("conflicts")
    .description(
      "List OPEN external-change conflicts (both versions recorded). A conflict persists until an " +
        "authorized resolution — last-writer-wins is not the default.",
    )
    .option("--project <key>", "restrict to one opaque Forge project key")
    .option("--provider <name>", "restrict to one external provider name")
    .option("--json", "emit the structured result as JSON")
    .action((opts: { project?: string; provider?: string; json?: boolean }) => {
      const scope: { projectIdentity?: string; provider?: string } = {};
      if (opts.project !== undefined) scope.projectIdentity = opts.project;
      if (opts.provider !== undefined) scope.provider = opts.provider;
      const open = listOpenConflicts(scope);
      if (opts.json) {
        console.log(JSON.stringify({ count: open.length, conflicts: open }, null, 2));
        return;
      }
      printConflicts(open);
    });

  // ─── conflicts-resolve (core->core: the AUTHORIZED store write) ───────────────────
  kanban
    .command("conflicts-resolve <conflictId>")
    .description(
      "Record an AUTHORIZED, host-operator resolution that CLOSES an open conflict. This is the ONLY " +
        "path that closes a conflict (never a remote/browser action), and closing it clears the " +
        "matching attention-inbox item on its next projection.",
    )
    .option("--by <actor>", "opaque operator/actor label recorded as resolution provenance", "host-operator")
    .option("--note <text>", "resolution rationale/disposition recorded with the closure", "")
    .option("--json", "emit the structured result as JSON")
    .action((conflictId: string, opts: { by: string; note: string; json?: boolean }) => {
      const existing = getConflict(conflictId);
      if (!existing) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: "not-found", conflictId }, null, 2));
        } else {
          console.error(`forge kanban conflicts-resolve: no conflict with id '${conflictId}'.`);
        }
        process.exitCode = 1;
        return;
      }
      if (existing.state !== "open") {
        if (opts.json) {
          console.log(
            JSON.stringify(
              { ok: false, error: "already-resolved", conflictId, resolvedBy: existing.resolvedBy, resolvedAt: existing.resolvedAt },
              null,
              2,
            ),
          );
        } else {
          console.error(
            `forge kanban conflicts-resolve: conflict '${conflictId}' is already resolved ` +
              `(by ${existing.resolvedBy ?? "?"} at ${existing.resolvedAt ?? "?"}).`,
          );
        }
        process.exitCode = 1;
        return;
      }

      const closed = resolveConflict(conflictId, {
        resolvedBy: opts.by,
        resolvedAt: new Date().toISOString(),
        resolution: opts.note,
      });
      // Only an `open` row transitions; a concurrent resolution could have closed it between the
      // read above and here, in which case resolveConflict is a no-op. Report the honest outcome.
      if (!closed) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, error: "already-resolved", conflictId }, null, 2));
        } else {
          console.error(`forge kanban conflicts-resolve: conflict '${conflictId}' was already resolved.`);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, conflictId, resolvedBy: opts.by }, null, 2));
        return;
      }
      console.log(`forge kanban conflicts-resolve: closed conflict '${conflictId}' (by ${opts.by}).`);
    });
}

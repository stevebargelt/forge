import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { assetRoot } from "../../v2/asset-root.js";
import { assertDashboardClosure } from "../../v2/release.js";
import { getDb, storeExists } from "../../store/db.js";
import { readBacklogConfig } from "../../backlog/config.js";
import { nowIso } from "../../util/ids.js";
import {
  AttentionDismissalConflict,
  activeAttentionDismissals,
  clearAttentionDismissal,
  isAttentionItemKey,
  parseSnoozeUntil,
  recordAttentionDismissal,
} from "../../store/attention-dismissals.js";
import { applyDismissals, composeInbox, renderAttentionInboxLines, type InboxEnvelope } from "../../v2/attention-inbox.js";

// FG-820: `forge attention list` — the Human Attention Inbox on the CLI. The derivation is
// core (deriveAttentionInbox), but its store readers are bound to the dashboard's project-
// scope resolution, so this shells into dashboard/src/attention/cli-entry.ts — the kanban
// `sync` layering precedent — which makes the SAME attentionInboxFor call GET
// /api/attention-inbox makes. `--json` therefore prints the envelope the dashboard serves.
// Read-only: the dashboard handle opens the store read-only, and a host with no store
// answers the empty inbox without creating one (FG-608).

export function resolveAttentionEntry(): { dashboardDir: string; entry: string } {
  const root = assetRoot();
  assertDashboardClosure(root);
  const dashboardDir = join(root, "dashboard");
  return { dashboardDir, entry: join(dashboardDir, "src", "attention", "cli-entry.ts") };
}

type EntryResult = InboxEnvelope | { error: string };

function readInbox(projectDir: string | undefined, runId: string | undefined): EntryResult {
  if (!storeExists()) {
    return composeInbox([], {
      generatedAt: new Date().toISOString(),
      scope: { runId: runId ?? null, projectDirs: projectDir === undefined ? null : [projectDir] },
    });
  }
  const { dashboardDir, entry } = resolveAttentionEntry();
  const args = ["--import", "tsx", entry];
  if (projectDir !== undefined) args.push("--project-dir", projectDir);
  if (runId !== undefined) args.push("--run", runId);
  // cwd=<dashboard> so tsx discovers dashboard/tsconfig.json and the `@forge/*` paths resolve.
  // stderr is inherited: a degraded source's diagnostic reaches the operator as it would
  // the dashboard's log.
  const child = spawnSync(process.execPath, args, {
    cwd: dashboardDir,
    env: { ...process.env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`the attention inbox read exited ${child.status ?? child.signal}`);
  return JSON.parse(child.stdout) as EntryResult;
}

// ─── FG-823: dismiss / snooze / undismiss — the ONLY writers of attention_dismissals ───
//
// The item is looked up in the SAME host-wide derivation `list` prints, so only an item
// the inbox is showing can be dismissed, and its kind/run are recorded from it. Any row
// that derivation found no longer holding (activity advanced, snooze passed) is marked
// in the same transaction — the readers are read-only, so the writer is where a lapse is
// persisted.

class AttentionRefusal extends Error {}

const MAX_RATIONALE_CHARS = 4000;

function actorOf(flag: string | undefined): string {
  const actor = (flag ?? process.env["USER"] ?? userInfo().username).trim();
  if (actor === "" || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) throw new AttentionRefusal("--actor must be a non-empty name");
  return actor;
}

function rationaleOf(flag: string | undefined): string | null {
  const text = flag?.trim() ?? "";
  if (text === "") return null;
  if (text.length > MAX_RATIONALE_CHARS) throw new AttentionRefusal(`--rationale must be at most ${MAX_RATIONALE_CHARS} characters`);
  return text;
}

function itemKeyOf(raw: string): string {
  if (!isAttentionItemKey(raw)) throw new AttentionRefusal(`${JSON.stringify(raw)} is not an attention item key (e.g. task:<task-id>, as \`forge attention list --json\` prints it)`);
  return raw;
}

function writeDismissal(itemKey: string, opts: { rationale?: string; actor?: string }, snoozeUntil: string | null): string {
  const actor = actorOf(opts.actor);
  const rationale = rationaleOf(opts.rationale);
  if (!storeExists()) throw new AttentionRefusal(`no open attention item ${itemKey}`);
  const envelope = readInbox(undefined, undefined);
  if ("error" in envelope) throw new Error(`the attention inbox is unavailable: ${envelope.error}`);
  const item = envelope.items.find((i) => i.id === itemKey);
  if (item === undefined) {
    const held = envelope.dismissed.find((d) => d.item.id === itemKey);
    if (held) {
      const how = held.dismissal.state === "snoozed" ? `snoozed until ${held.dismissal.snoozeUntil}` : "dismissed";
      throw new AttentionRefusal(`${itemKey} is already ${how}; run \`forge attention undismiss ${itemKey}\` first`);
    }
    throw new AttentionRefusal(`no open attention item ${itemKey} (see \`forge attention list --json\`)`);
  }
  const at = nowIso();
  const shown = [...envelope.items, ...envelope.dismissed.map((d) => d.item)];
  const lapses = applyDismissals(shown, activeAttentionDismissals(getDb()), at).lapsed.map(({ id, state }) => ({ id, state }));
  const projectDir = item.links.projectDir;
  const projectKey = projectDir !== null && existsSync(projectDir) ? readBacklogConfig(projectDir).projectKey : null;
  try {
    recordAttentionDismissal({ itemKey, kind: item.kind, projectKey, runId: item.links.runId, actor, rationale, snoozeUntil, at }, lapses);
  } catch (err) {
    if (err instanceof AttentionDismissalConflict) throw new AttentionRefusal(err.message);
    throw err;
  }
  return snoozeUntil === null
    ? `dismissed ${itemKey} (${item.kind}) — hidden until its activity advances; undo: forge attention undismiss ${itemKey}`
    : `snoozed ${itemKey} (${item.kind}) until ${snoozeUntil} — or until its activity advances; undo: forge attention undismiss ${itemKey}`;
}

function runWriter(verb: string, write: () => string): void {
  try {
    console.log(write());
  } catch (err) {
    if (!(err instanceof AttentionRefusal)) throw err;
    console.error(`forge attention ${verb}: ${err.message}`);
    process.exitCode = 1;
  }
}

export function registerAttention(program: Command): void {
  const attention = program
    .command("attention")
    .description("The Human Attention Inbox: open items that need an operator, derived as the dashboard derives them.");

  attention
    .command("list")
    .option("--project <dir>", "scope to one project checkout (default: host-wide, as the dashboard's unscoped inbox)")
    .option("--run <run-id>", "only items linked to this run")
    .option("--json", "print the inbox envelope exactly as GET /api/attention-inbox serves it")
    .option("--include-dismissed", "also list the dismissed and snoozed items, with their dismissal state (--json always carries them under `dismissed`)")
    .description("List open attention items (read-only).")
    .action((opts: { project?: string; run?: string; json?: boolean; includeDismissed?: boolean }) => {
      const projectDir = opts.project === undefined ? undefined : resolve(opts.project);
      const result = readInbox(projectDir, opts.run);
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      if ("error" in result) {
        if (!opts.json) console.error(`forge attention list: the attention inbox is unavailable: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) return;
      for (const line of renderAttentionInboxLines(result, { includeDismissed: opts.includeDismissed === true })) console.log(line);
    });

  attention
    .command("dismiss <item-key>")
    .option("--rationale <text>", "why — recorded with the dismissal and its event")
    .option("--actor <name>", "who is dismissing it (default: $USER)")
    .description("Hide an attention item until its source shows new activity. Audited: writes an attention.dismissed event.")
    .action((itemKey: string, opts: { rationale?: string; actor?: string }) => {
      runWriter("dismiss", () => writeDismissal(itemKeyOf(itemKey), opts, null));
    });

  attention
    .command("snooze <item-key>")
    .requiredOption("--until <ISO|duration>", "when it returns: a duration from now (1h, 4h, 1d, 2w) or an ISO-8601 instant")
    .option("--rationale <text>", "why — recorded with the snooze and its event")
    .option("--actor <name>", "who is snoozing it (default: $USER)")
    .description("Hide an attention item until a time (or new activity, whichever is first). Audited: writes an attention.snoozed event.")
    .action((itemKey: string, opts: { until: string; rationale?: string; actor?: string }) => {
      runWriter("snooze", () => {
        const key = itemKeyOf(itemKey);
        const until = parseSnoozeUntil(opts.until, Date.now());
        if (!until.ok) throw new AttentionRefusal(until.error);
        return writeDismissal(key, opts, until.until);
      });
    });

  attention
    .command("undismiss <item-key>")
    .option("--actor <name>", "who is undismissing it (default: $USER)")
    .description("Clear an item's dismissal or snooze so it shows again. Audited: writes an attention.undismissed event.")
    .action((itemKey: string, opts: { actor?: string }) => {
      runWriter("undismiss", () => {
        const key = itemKeyOf(itemKey);
        const actor = actorOf(opts.actor);
        const cleared = storeExists() ? clearAttentionDismissal(key, actor, nowIso()) : null;
        if (cleared === null) throw new AttentionRefusal(`${key} has no active dismissal or snooze`);
        return `undismissed ${key} — it shows again while its source still produces it`;
      });
    });
}

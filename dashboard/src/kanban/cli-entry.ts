// FG-785: the RUNNABLE node entrypoint the core `forge kanban sync` command shells into.
//
// WHY IT LIVES HERE. The FG-781 projection (assembleRemoteBoard + the to* mappers) is
// dashboard-workspace-internal — it imports queries.ts / attention-inbox.ts, which are not core
// modules. Rather than invert the package layering by promoting all of that into core, the core
// CLI shells into THIS entry exactly as `forge dashboard` shells into dashboard/src/server.ts
// (src/cli/commands/dashboard.ts). It is the ONE place that:
//   1. reads provider credentials from the host environment AT THE EDGE, and
//   2. calls assembleRemoteBoard to produce the sealed card-data source,
// then hands both to the pure sync engine. The credential never reaches a persisted row, a log
// line, or the printed summary — it is read into a local, passed to the provider factory, and
// dropped (AC6; the negative proof is the step-7 credential-leak test).
//
// OUTBOUND-ONLY. This entry runs a one-way projection and nothing else. There is no inbound flag,
// no external-to-Forge write path, and no resolution verb here — conflict resolution is a
// host-operator store write via `forge kanban conflicts-resolve` (step 6), never this projection.
//
// REFERENCE PROVIDER ONLY. Only the deterministic in-memory FakeKanbanProvider ships this release
// (a real adapter is a later addition). The fake holds board state in memory, so a real
// `forge kanban sync` reference run projects the current board into a fresh fake each process;
// cross-process convergence is a property of a persistent real provider. The DURABLE identity /
// conflict tables persist regardless, through the store accessors below.

import { pathToFileURL } from "node:url";
import {
  getConflict,
  getProjectionMap,
  insertConflict,
  listProjectionMap,
  upsertProjectionMap,
} from "@forge/kanban-projection";
import { assembleRemoteBoard, type RemoteBoard } from "../remote/projection.js";
import { projectsForDashboard } from "../queries.js";
import type { KanbanProvider } from "./adapter.js";
import { FakeKanbanProvider } from "./fake-provider.js";
import { syncBoardOutbound, type KanbanSyncStore, type SyncConfig, type SyncResult } from "./sync.js";

// ─── credential handling (host edge only) ───────────────────────────────────────────

/** Read the provider credential from the host environment ONLY. The env var name is derived from
 *  the opaque provider name; the VALUE is returned to the caller for the provider factory and is
 *  never logged, persisted, or echoed. A fresh read each call so nothing caches it in a longer-lived
 *  scope than necessary. */
export function readProviderCredential(providerName: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const upper = providerName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  // Provider-specific first, then a generic fallback — both host-environment only.
  return env[`FORGE_KANBAN_${upper}_TOKEN`] ?? env[`FORGE_KANBAN_TOKEN`] ?? undefined;
}

// ─── provider registry (only the fake ships) ────────────────────────────────────────

/** A provider factory: given the opaque name and the host-read credential, build an adapter. The
 *  credential is accepted so a real adapter can authenticate; the fake ignores it (proving the
 *  edge hands it over without the engine or store ever seeing it). */
export type ProviderFactory = (opts: { name: string; credential?: string }) => KanbanProvider;

export const DEFAULT_PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  // The deterministic reference provider. It ignores the credential entirely.
  fake: ({ name }) => new FakeKanbanProvider({ name }),
};

// ─── the real store port (the two FG-785 accessors, bundled) ─────────────────────────

const realStore: KanbanSyncStore = { getProjectionMap, listProjectionMap, upsertProjectionMap, insertConflict, getConflict };

// ─── argv parsing ────────────────────────────────────────────────────────────────

export type KanbanSyncArgs = { project: string; provider: string };

/** Parse the entry argv. `--project <key>` is required; `--provider <name>` defaults to "fake".
 *  Throws a named error (never prints the raw argv, which could carry a credential someone wrongly
 *  passed on the command line) on a missing project. */
export function parseKanbanSyncArgs(argv: readonly string[]): KanbanSyncArgs {
  let project: string | undefined;
  let provider = "fake";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") project = argv[++i];
    else if (arg === "--provider") provider = argv[++i] ?? provider;
  }
  if (!project) {
    throw new Error("forge kanban sync: --project <projectKey> is required");
  }
  return { project, provider };
}

// ─── the entry ──────────────────────────────────────────────────────────────────

export type KanbanSyncEntryDeps = {
  /** Resolve the RemoteBoard for a project key (defaults to the FG-781 assembler over the
   *  dashboard registry). Injectable so tests can drive a hand-built board without seeding a DB. */
  boardSource?: (projectKey: string) => RemoteBoard;
  providerFactories?: Record<string, ProviderFactory>;
  store?: KanbanSyncStore;
  env?: NodeJS.ProcessEnv;
  /** Config overrides (clock, retry policy, sleep) — real defaults otherwise. */
  config?: Partial<Pick<SyncConfig, "now" | "retry" | "sleep" | "projectedBy" | "detectedBy">>;
};

/** The default board source: resolve the granted project from the dashboard registry and assemble
 *  the FG-781 remote board STRICTLY over its own member dirs (never resolveProjectScope's widened
 *  scope — the same strict pinning the remote board uses). Throws a named error when the project
 *  is unknown, so a sync can never silently project an empty board. */
export function defaultBoardSource(projectKey: string): RemoteBoard {
  const project = projectsForDashboard().find((p) => p.key === projectKey);
  if (!project) {
    throw new Error(`forge kanban sync: project '${projectKey}' is not known to this host`);
  }
  const envelope = assembleRemoteBoard({ project, memberDirs: project.projectDirs });
  if (!envelope.board) {
    throw new Error(`forge kanban sync: the remote board for '${projectKey}' is unavailable (${envelope.state})`);
  }
  return envelope.board;
}

/** Run one outbound sync for the parsed args and return the summary. Reads the credential at the
 *  edge, constructs the provider, assembles the sealed board, and runs the pure engine. The returned
 *  summary carries counts and per-ticket outcomes ONLY — never a credential or a card body. */
export async function runKanbanSyncEntry(
  args: KanbanSyncArgs,
  deps: KanbanSyncEntryDeps = {},
): Promise<SyncResult> {
  const env = deps.env ?? process.env;
  const factories = deps.providerFactories ?? DEFAULT_PROVIDER_FACTORIES;
  const factory = factories[args.provider];
  if (!factory) {
    throw new Error(
      `forge kanban sync: unknown provider '${args.provider}'. Only the reference provider 'fake' ships this release.`,
    );
  }

  // Read the credential at the edge and hand it to the factory. It is never referenced again.
  const credential = readProviderCredential(args.provider, env);
  const provider = factory({ name: args.provider, credential });

  const boardSource = deps.boardSource ?? defaultBoardSource;
  const board = boardSource(args.project);

  const store = deps.store ?? realStore;
  const config: SyncConfig = {
    projectIdentity: args.project,
    provider: args.provider,
    projectedBy: deps.config?.projectedBy ?? "kanban-sync",
    detectedBy: deps.config?.detectedBy ?? "kanban-sync",
    now: deps.config?.now ?? (() => new Date().toISOString()),
    ...(deps.config?.retry ? { retry: deps.config.retry } : {}),
    ...(deps.config?.sleep ? { sleep: deps.config.sleep } : {}),
  };

  return syncBoardOutbound(board, provider, store, config);
}

/** The process entrypoint: parse argv, run the sync, print a credential-free JSON summary to
 *  stdout, and exit nonzero if any card errored (so the shelling CLI surfaces a failed sync). */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseKanbanSyncArgs(argv);
  const result = await runKanbanSyncEntry(args);
  // Summary ONLY — counts + per-ticket outcomes. No credential, no card body, no host path.
  process.stdout.write(JSON.stringify(result) + "\n");
  return result.errors > 0 ? 1 : 0;
}

// Run when invoked directly (the core CLI shells `node --import tsx cli-entry.ts …`). Guarded so a
// test that imports the module never triggers the process runner.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      // Named error to stderr — never the raw argv/env, so a mistakenly-passed credential is not
      // echoed. The message text comes from our own thrown Errors above.
      process.stderr.write(`forge kanban sync failed: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}

// FG-607 (FG-496 Slice B): which store is AUTHORITATIVE for a project's backlog.
//
// The mode lives in the DB keyed by project_key (Slice A's host-side record), NOT
// in each worktree's .forge/config.yml — two linked worktrees can therefore never
// disagree about which store owns the tickets. The answer is authoritative: the
// seam reads db OR Markdown, never both, and never falls back from one to the
// other (read-through blending is the split-truth bug FG-496 exists to kill).
//
// This module is a PURE IDENTITY READER. It must never call
// resolveAndClaimProjectKey (which INSERTs a project_identity row) and never call
// writeProjectKey (which writes the git-TRACKED .forge/config.yml). Minting an
// identity or healing config is reserved for `forge backlog import` and
// `forge backlog mode --set`, where an operator is present and a dirty config is
// expected. A `forge backlog list` that healed config would dirty git status and
// mint identity rows for every throwaway directory forge is ever pointed at.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBacklogConfig } from "./config.js";
import { getStorageMode } from "../store/tickets.js";
import { dbGeneration, storeExists } from "../store/db.js";
import {
  computeRepositoryEvidence,
  registryByEvidence,
  registryByKey,
  ProjectIdentityConflictError,
} from "../store/project-registry.js";

export type BacklogStore =
  | { mode: "markdown"; projectKey: string | null; staleMarkdown: false }
  | { mode: "db"; projectKey: string; staleMarkdown: boolean };

const MARKDOWN_UNKNOWN: BacklogStore = { mode: "markdown", projectKey: null, staleMarkdown: false };

// Memoized to collapse the per-loop resolution storms (campaign planner, report,
// done-audit collect all call readTicket/listTickets in tight loops); without it
// each call would pay a git subprocess and a getDb() open.
//
// The TTL is what makes it correct in a LONG-RUNNING process: the dashboard would
// otherwise serve the old store forever after an operator flips a project's mode.
// A few seconds is the whole point — long enough to collapse a loop, short enough
// that no invalidation plumbing is needed.
//
// The generation is what makes it correct across a CONNECTION change. A TTL
// bounds staleness in time; it does not bound it to the store the answer came
// from. A process that closes its DB and reopens another one (a restart
// simulation, a test swapping stores) would otherwise be handed a `db`-mode
// project_key resolved against the DEAD connection and go read — or write —
// tickets under it in a store that never registered that project. Entries are
// keyed to the connection generation they were resolved under, so a swap
// invalidates them on the spot.
const CACHE_TTL_MS = 3_000;
const cache = new Map<string, { store: BacklogStore; generation: number; expiresAt: number }>();

/** Drop the memoized resolutions. Called after `forge backlog mode --set` (the
 *  CLI's immediate-consistency case) and by tests that swap the DB or flip a
 *  project's mode mid-process. */
export function clearBacklogStoreCache(): void {
  cache.clear();
}

function storeFor(projectDir: string, projectKey: string): BacklogStore {
  const mode = getStorageMode(projectKey);
  if (mode === "db") {
    return { mode: "db", projectKey, staleMarkdown: existsSync(join(projectDir, "backlog")) };
  }
  return { mode: "markdown", projectKey, staleMarkdown: false };
}

// Rung 1 — a committed project_key, CROSS-CHECKED against the registry before it
// is trusted. .forge/config.yml is git-tracked and freely copyable, so an
// unchecked key lets a project carrying another project's key read AND WRITE that
// project's tickets. The registry is the durable arbiter of which repository owns
// a key; the two refusals below are the read-side halves of the identity ladder's
// rung-5 refusals (project-registry.ts:154-188), and they REFUSE rather than fall
// through to another rung or downgrade to markdown.
function storeForConfigKey(projectDir: string, configKey: string): BacklogStore {
  const evidenceKey = computeRepositoryEvidence(projectDir).key;

  const owner = registryByKey(configKey);
  if (owner && owner.repoEvidenceKey !== evidenceKey) {
    throw new ProjectIdentityConflictError(
      `forge: refusing to read the backlog — project_key '${configKey}' (from .forge/config.yml) is ` +
        `registered to a DIFFERENT repository evidence ('${owner.repoEvidenceKey}'), but this ` +
        `checkout's evidence is '${evidenceKey}'.\n` +
        `FG-608 — repair depends on WHICH SIDE moved, and the two look identical from here:\n` +
        `  * The EVIDENCE moved (the common case once a project has cut over): the repository ` +
        `evidence key is SOURCE-DEPENDENT — repositoryCheckoutIdentity prefers a normalized remote and ` +
        `falls back to the git common dir, so a repository registered while it had NO remote gets a ` +
        `DIFFERENT evidence key the moment \`git remote add origin\` runs. Nothing about the project ` +
        `changed; only the evidence did, and .forge/config.yml is RIGHT. Fix it with ` +
        `\`forge backlog reidentify --confirm --key ${configKey}\`, which re-points the registry's ` +
        `evidence for that key at this checkout.\n` +
        `  * The KEY moved (a project_key genuinely copied between unrelated repos): reading or ` +
        `writing under it would touch the other project's tickets. Give this repository its own ` +
        `project_key in .forge/config.yml (or remove the copied key and run \`forge backlog import\` ` +
        `to mint a fresh one).`,
      {
        evidenceKey,
        configKey,
        registeredKey: owner.projectKey,
        registeredEvidenceKey: owner.repoEvidenceKey,
      },
    );
  }

  const registered = registryByEvidence(evidenceKey);
  if (registered && registered.projectKey !== configKey) {
    throw new ProjectIdentityConflictError(
      `forge: refusing to read the backlog — this repository (evidence '${evidenceKey}') is ` +
        `registered to project_key '${registered.projectKey}', but .forge/config.yml commits a ` +
        `DIFFERENT key '${configKey}'.\n` +
        `Repair depends on WHICH SIDE moved:\n` +
        `  * The EVIDENCE moved (the common case, and the one FG-608 made reachable): the repository ` +
        `evidence key is SOURCE-DEPENDENT — repositoryCheckoutIdentity prefers a normalized remote and ` +
        `falls back to the git common dir, so a repository registered while it had NO remote gets a ` +
        `DIFFERENT evidence key the moment \`git remote add origin\` runs. Nothing about the project ` +
        `changed; only the evidence did. Fix it with \`forge backlog reidentify --confirm --key ` +
        `${configKey}\`, which re-points the registry's evidence for that key at this checkout.\n` +
        `  * The KEY moved (a project_key genuinely copied from another repository): reconcile ` +
        `.forge/config.yml to '${registered.projectKey}' (the registered owner) instead.`,
      {
        evidenceKey,
        configKey,
        registeredKey: registered.projectKey,
        registeredEvidenceKey: registered.repoEvidenceKey,
      },
    );
  }

  return storeFor(projectDir, configKey);
}

function resolveUncached(projectDir: string): BacklogStore {
  const config = readBacklogConfig(projectDir);
  if (config.projectKey) return storeForConfigKey(projectDir, config.projectKey);

  // No store on this host at all: nothing has ever been imported anywhere, so no
  // registry row can exist. Answer markdown for FREE — no git subprocess, and no
  // DB open (which would CREATE forge.db just to find nothing).
  if (!storeExists()) return MARKDOWN_UNKNOWN;

  // No committed key — the case the registry rung exists to serve:
  // .forge/config.yml is git-tracked and per-branch, so a linked worktree sitting
  // on a branch that predates the project_key commit legitimately has no key. It
  // may well still have a stale backlog/ directory (that is git-tracked too);
  // answering markdown on EITHER basis would let two linked worktrees of one
  // project disagree about authority. Only the registry can tell "never imported"
  // apart from "imported, but this branch predates the key commit" — and
  // repositoryCheckoutIdentity converges linked worktrees, which is the whole
  // mechanism behind AC 2. So ask it, always. A PURE READ.
  const row = registryByEvidence(computeRepositoryEvidence(projectDir).key);
  if (!row) return MARKDOWN_UNKNOWN;

  return storeFor(projectDir, row.projectKey);
}

export function resolveBacklogStore(projectDir: string): BacklogStore {
  const key = resolve(projectDir);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now && hit.generation === dbGeneration()) return hit.store;
  const store = resolveUncached(key);
  // Read AFTER resolving: resolveUncached may itself be the call that opens the
  // store, and the entry must carry the generation it was actually derived from.
  cache.set(key, { store, generation: dbGeneration(), expiresAt: now + CACHE_TTL_MS });
  return store;
}

/** The single answer to "does this project have a backlog forge can work with".
 *  In db mode the tickets live in the host DB, so a project with no backlog/
 *  directory at all still has one. */
export function projectHasBacklog(projectDir: string): boolean {
  if (resolveBacklogStore(projectDir).mode === "db") return true;
  return existsSync(join(projectDir, "backlog"));
}

/** The one-line store banner the CLI prints to stderr on every invocation. */
export function describeBacklogStore(store: BacklogStore): string {
  if (store.mode === "markdown") return "store: legacy markdown";
  return (
    `store: db (project_key=${store.projectKey})` +
    (store.staleMarkdown ? " — backlog/ present but NOT authoritative" : "")
  );
}

// FG-606 (FG-496 Slice A): the project-identity registry — the single durable
// arbiter of which project_key a repository owns. The shared host DB
// (~/.forge/forge.db) holds tickets for many projects keyed by
// (project_key, ticket_id); the single greatest hazard in this slice is two
// worktrees of ONE project independently minting DIFFERENT keys and creating two
// DB backlogs for what is one project. This module makes that impossible.
//
// Identity is keyed on repositoryCheckoutIdentity (remote > git-common-dir >
// path, realpath-canonicalized) — the CONVERGING evidence key that groups linked
// worktrees and independent clones. Deliberately NOT v2/project-identity.ts,
// which diverges per physical checkout by design.
//
// The registry implements a 5-rung authority-precedence ladder with NO silent
// choice at any rung:
//   1. config and registry AGREE                 -> proceed
//   2. config ABSENT, registry EXISTS            -> adopt the registry key (heal config)
//   3. registry ABSENT, config EXISTS            -> atomically CLAIM that mapping
//   4. BOTH absent                               -> DETERMINISTICALLY DERIVE a key from
//                                                   the converging evidence key (so two
//                                                   worktrees converge to the SAME
//                                                   candidate BEFORE the claim races),
//                                                   atomically CLAIM, then persist to config
//   5. ANY mismatch or uniqueness conflict       -> REFUSE (stop-and-surface)
//
// resolveAndClaimProjectKey MUST be called inside the caller's writeTransaction
// (BEGIN IMMEDIATE) so the read + CLAIM + the whole import are one atomic unit: a
// losing concurrent claimant's INSERT hits the two-directional uniqueness, the
// whole transaction rolls back, and it retries against the winner's mapping.

import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import {
  repositoryCheckoutIdentity,
  type RepositoryCheckoutIdentity,
} from "../util/repository-identity.js";
import type { GitRunner } from "../util/github-url.js";

export type RegistryRow = {
  projectKey: string;
  repoEvidenceKey: string;
  repoEvidenceSource: string;
  createdAt: string;
};

// A REFUSE outcome — two identities disagree for what is (or claims to be) one
// project. Surfaces BOTH identities and an operator repair path. NEVER swallowed:
// forge must not silently maintain two DB backlogs.
export class ProjectIdentityConflictError extends Error {
  constructor(
    message: string,
    readonly detail: {
      evidenceKey: string;
      configKey?: string | null;
      registeredKey?: string | null;
      registeredEvidenceKey?: string | null;
    },
  ) {
    super(message);
    this.name = "ProjectIdentityConflictError";
  }
}

// A CLAIM lost a race to a concurrent writer (the two-directional uniqueness
// fired). The caller rolls its transaction back and RETRIES; on retry the
// winner's mapping is committed and resolution cleanly adopts (or refuses).
export class ProjectIdentityClaimRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectIdentityClaimRaceError";
  }
}

function isUniqueConstraintError(e: unknown): boolean {
  const code = (e as { code?: string } | undefined)?.code;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
    code === "SQLITE_CONSTRAINT"
  );
}

// Deterministic derivation from the CONVERGING evidence key (rung 4). Two
// worktrees at different real paths resolve the SAME evidence key via
// repositoryCheckoutIdentity, so they derive the SAME candidate project_key
// BEFORE either claims — the claim then serializes them; it does not decide the
// key. The `pk-` prefix distinguishes a minted project_key from the `repo-`
// evidence key it derives from.
export function deriveProjectKey(evidenceKey: string): string {
  return `pk-${createHash("sha256").update(`project_key:${evidenceKey}`).digest("hex").slice(0, 20)}`;
}

export function computeRepositoryEvidence(
  projectDir: string,
  git?: GitRunner,
): RepositoryCheckoutIdentity {
  return git ? repositoryCheckoutIdentity(projectDir, git) : repositoryCheckoutIdentity(projectDir);
}

function rowToRegistry(row: {
  project_key: string;
  repo_evidence_key: string;
  repo_evidence_source: string;
  created_at: string;
}): RegistryRow {
  return {
    projectKey: row.project_key,
    repoEvidenceKey: row.repo_evidence_key,
    repoEvidenceSource: row.repo_evidence_source,
    createdAt: row.created_at,
  };
}

export function registryByEvidence(evidenceKey: string): RegistryRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM project_identity WHERE repo_evidence_key = ?`)
    .get(evidenceKey) as Parameters<typeof rowToRegistry>[0] | undefined;
  return row ? rowToRegistry(row) : undefined;
}

export function registryByKey(projectKey: string): RegistryRow | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM project_identity WHERE project_key = ?`)
    .get(projectKey) as Parameters<typeof rowToRegistry>[0] | undefined;
  return row ? rowToRegistry(row) : undefined;
}

export type ResolveInput = {
  evidenceKey: string;
  evidenceSource: string;
  configKey: string | null;
  createdAt: string;
};

export type ResolveResult = {
  projectKey: string;
  // Rung the ladder resolved on — surfaced for logging/tests, never a decision input.
  rung: 1 | 2 | 3 | 4;
  // True when config lacked a key and it should be persisted after commit
  // (rungs 2 and 4). The orchestrator writes config AFTER the durable commit.
  persistToConfig: boolean;
};

// The ladder. MUST run inside the caller's writeTransaction so read + CLAIM are
// atomic. Throws ProjectIdentityConflictError (rung 5 REFUSE) or
// ProjectIdentityClaimRaceError (lost a concurrent claim — caller retries).
export function resolveAndClaimProjectKey(input: ResolveInput): ResolveResult {
  const { evidenceKey, evidenceSource, configKey, createdAt } = input;

  const rowE = registryByEvidence(evidenceKey);
  const rowC = configKey ? registryByKey(configKey) : undefined;

  // Reverse-direction conflict: the config's project_key is already registered to
  // a DIFFERENT repository (a copied key / accidental backlog merge). REFUSE.
  if (configKey && rowC && rowC.repoEvidenceKey !== evidenceKey) {
    throw new ProjectIdentityConflictError(
      `forge: refusing import — project_key '${configKey}' (from .forge/config.yml) is already ` +
        `owned by a DIFFERENT repository (evidence '${rowC.repoEvidenceKey}'), but this checkout's ` +
        `evidence is '${evidenceKey}'. A project_key was likely copied between unrelated repos. ` +
        `Repair: give this repository its own project_key in .forge/config.yml (or remove the copied ` +
        `key and re-import to mint a fresh one).`,
      {
        evidenceKey,
        configKey,
        registeredKey: rowC.projectKey,
        registeredEvidenceKey: rowC.repoEvidenceKey,
      },
    );
  }

  if (rowE) {
    // This repository already owns a key in the registry.
    if (configKey && rowE.projectKey !== configKey) {
      // Divergent committed keys: config says one key, the registry (claimed by an
      // earlier import of a linked worktree/clone) says another. REFUSE.
      throw new ProjectIdentityConflictError(
        `forge: refusing import — this repository (evidence '${evidenceKey}') is registered to ` +
          `project_key '${rowE.projectKey}', but .forge/config.yml commits a DIFFERENT key ` +
          `'${configKey}'. Two branches/worktrees carry divergent committed keys for one project. ` +
          `Repair: reconcile .forge/config.yml to '${rowE.projectKey}' (the registered owner) and ` +
          `re-import.`,
        {
          evidenceKey,
          configKey,
          registeredKey: rowE.projectKey,
          registeredEvidenceKey: rowE.repoEvidenceKey,
        },
      );
    }
    // Rung 1 (config agrees) or rung 2 (config absent -> adopt & heal).
    return {
      projectKey: rowE.projectKey,
      rung: configKey ? 1 : 2,
      persistToConfig: !configKey,
    };
  }

  // rowE absent — must CLAIM. Rung 3 uses the committed config key; rung 4
  // deterministically DERIVES from the converging evidence key.
  const projectKey = configKey ?? deriveProjectKey(evidenceKey);
  try {
    getDb()
      .prepare(
        `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(projectKey, evidenceKey, evidenceSource, createdAt);
  } catch (e) {
    if (isUniqueConstraintError(e)) {
      // A concurrent claimant committed the evidence->key (or key->evidence)
      // mapping first. Roll back and retry: re-resolution will adopt the winner's
      // mapping (rung 1/2) or REFUSE if the committed keys genuinely diverge.
      throw new ProjectIdentityClaimRaceError(
        `project_key claim lost a concurrent race for evidence '${evidenceKey}'; retrying`,
      );
    }
    throw e;
  }

  return {
    projectKey,
    rung: configKey ? 3 : 4,
    persistToConfig: !configKey,
  };
}

// FG-425: canonical project identity — the ONE key the publication lane and the
// publication mutex are both keyed on.
//
// Salvaged from the abandoned branch fix/fg425-project-gate-locking@ce22024
// (projectIntegrationLockKey / describeWait). Everything else on that branch —
// the long integration lock and the whole gate process-supervision layer — is
// discarded: see learnings/decisions/serialized-integration-publisher.md.
//
// Two runs pointed at one repo through different spellings (symlink, trailing
// slash, relative path) must collapse to ONE identity, or they would each get
// their own lane and publish against each other's moving target. realpath is
// what collapses them.

import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type ProjectIdentity = {
  /** Stable hash of the canonical dir. The lane key and the mutex key. */
  key: string;
  /** The physical directory, symlinks resolved. Operator-facing. */
  canonicalDir: string;
};

/** Canonicalize a projectDir to one identity. When realpath can't resolve the
 *  path (deleted mid-run), fall back to path.resolve so the key is still
 *  deterministic rather than throwing on the publication path. */
export function projectIdentity(projectDir: string): ProjectIdentity {
  let canonicalDir: string;
  try {
    canonicalDir = realpathSync(projectDir);
  } catch {
    canonicalDir = resolve(projectDir);
  }
  const key = createHash("sha256").update(canonicalDir).digest("hex").slice(0, 16);
  return { key, canonicalDir };
}

/** The operator-visible contention line, salvaged from the abandoned branch.
 *  Used for BOTH waits: the FIFO lane queue (long — spans another attempt's
 *  validation) and the short publication window (CAS + fast-forward only). It
 *  always names WHO holds, WHAT is being waited on, HOW LONG, and the next
 *  action — a waiting forge must never look like a hung one. */
export function describeWait(opts: {
  what: "lane" | "publication-window";
  canonicalDir: string;
  holderRunId?: string | undefined;
  holderAttemptId?: string | undefined;
  elapsedMs: number;
  position?: number | undefined;
}): string {
  const holder = opts.holderRunId ? `run ${opts.holderRunId}` : "another attempt";
  const attempt = opts.holderAttemptId ? ` (attempt ${opts.holderAttemptId})` : "";
  const where = opts.position !== undefined ? `, ${opts.position} ahead of us` : "";
  const subject =
    opts.what === "lane"
      ? "the integration lane"
      : "the publication window";
  return (
    `forge: waiting for ${subject} on ${opts.canonicalDir} — held by ${holder}${attempt}${where}, ` +
    `${Math.round(opts.elapsedMs / 1000)}s waited. ` +
    `Inspect with \`forge publish lane --project ${opts.canonicalDir}\`` +
    (opts.holderRunId ? ` or \`forge show ${opts.holderRunId}\`` : "") +
    `.`
  );
}

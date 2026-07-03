// FG-443: IO collector for the out-of-band completion path (awaiting_gate items
// delivered outside the feature pipeline — see reconcile-outofband-evidence.ts).
//
// Reuses checkClosedCommitReachableOnBase (reconcile-collect.ts) for the base-branch
// reachability check rather than re-implementing SHA/ref validation and the
// `git merge-base --is-ancestor` call. Lane evidence is derived from a conservative
// git-diff allowlist (commitTouchesOnlyNonCodePaths) and safe-denies on any
// ambiguity; when the closing commit touches code paths, lane evidence falls back
// to the same host-verification lookup reconcile-collect.ts uses. This file
// deliberately never calls eventsForRun or reads item.runId as a completeness
// signal — the delivering work happened outside that run, so its run's event
// history (present, absent, or failing) must not affect the result here.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTicket } from "../backlog/structured.js";
import { queryHostVerificationRowsForGate } from "../store/host-verifications.js";
import type { CampaignItem } from "../types/index.js";
import { checkClosedCommitCoveredByTestedSha, checkClosedCommitReachableOnBase } from "./reconcile-collect.js";
import type { OutOfBandEvidenceInput, OutOfBandLaneEvidence } from "./reconcile-outofband-evidence.js";

// Intentionally duplicated from reconcile-collect.ts (same pattern report.ts uses
// for isHostLocalNoisePath) — both collectors read the same on-disk config
// independently rather than sharing a helper across a public/private boundary.
function readConfigString(projectDir: string, key: string, fallback: string): string {
  try {
    const raw = readFileSync(join(projectDir, ".forge", "config.json"), "utf8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (typeof config[key] === "string") return config[key] as string;
  } catch {
    // missing or malformed config — fallback stands
  }
  return fallback;
}

// closedCommit is operator-editable ticket frontmatter — reject anything that
// isn't a plausible sha before it reaches git as a positional arg (same guard
// reconcile-collect.ts applies).
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

// Conservative allowlist: any path with a documentation-content extension
// (.md, .mdx, .txt), regardless of directory. Being under docs/ is NOT
// sufficient on its own — docs/deploy.sh, docs/tool.ts, docs/build.js are code
// and must be denied, or a delivery containing real code could be misclassified
// as non_code_diff lane evidence and skip the host-verification fallback. A
// path outside this list — or any git error, empty diff, or ambiguous parent —
// safe-denies to false in commitTouchesOnlyNonCodePaths below. Never widen this
// on the caller's say-so.
const MARKDOWN_PATTERN = /\.(mdx?|txt)$/i;

function isNonCodePath(path: string): boolean {
  return MARKDOWN_PATTERN.test(path);
}

export function commitTouchesOnlyNonCodePaths(projectDir: string, closedCommit: string): boolean {
  if (!SHA_PATTERN.test(closedCommit)) return false;

  let parentsLine: string;
  try {
    // closedCommit before `--` (not after): rev-list treats args after `--` as
    // pathspecs, and a bare "-- <sha>" would be parsed as "no revision, filter by
    // path <sha>" — which fails loud (caught below) rather than resolving the
    // commit. closedCommit is already SHA_PATTERN-validated above, so it cannot
    // be mistaken for an option even without a preceding `--`.
    parentsLine = execFileSync("git", ["rev-list", "--parents", "-n", "1", closedCommit, "--"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return false;
  }

  // First token is the commit itself; anything other than exactly one parent
  // (a root commit with zero, or a merge commit with two+) is ambiguous for a
  // single-parent diff — safe-deny rather than guess which parent is "the" base.
  const shas = parentsLine.split(/\s+/).filter(Boolean);
  if (shas.length !== 2) return false;
  const parent = shas[1]!;

  let rawOutput: string;
  try {
    // --raw + newmode inspection (not --name-only) — a path's extension alone
    // doesn't tell you whether the blob at that path is a plain file, an
    // executable, a symlink, or a submodule pointer; all four can share a
    // docs/*.md-looking path. --no-renames keeps each record to a single
    // mode/path pair (no R/C two-path records to parse). -z NUL-delimits
    // records and disables path quoting, so a legitimate unicode path like
    // docs/résumé.md is read verbatim instead of being quoted and missed by
    // the anchored path checks below.
    rawOutput = execFileSync("git", ["diff", "--raw", "-z", "--no-renames", parent, closedCommit, "--"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    return false;
  }

  const fields = rawOutput.split("\0").filter((field) => field.length > 0);
  // Odd count means a meta line without its paired path field (or vice versa) —
  // a parse we don't understand, so fail closed rather than guess.
  if (fields.length === 0 || fields.length % 2 !== 0) return false;

  const RAW_ENTRY_PATTERN = /^:[0-7]{6} ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*$/;

  for (let i = 0; i < fields.length; i += 2) {
    const meta = fields[i]!;
    const path = fields[i + 1]!;
    const match = RAW_ENTRY_PATTERN.exec(meta);
    if (!match) return false;
    if (!isNonCodePath(path)) return false;

    const newMode = match[1]!;
    // 000000 = deletion — no new content is delivered at this path, so the mode
    // check below doesn't apply; the path-extension check above already covers it.
    if (newMode === "000000") continue;
    // Allowlist the one safe mode (plain non-executable regular file) rather than
    // denylist unsafe ones — executable (100755), symlink (120000),
    // gitlink/submodule (160000), or anything else fails closed.
    if (newMode !== "100644") return false;
  }

  return true;
}

export function collectOutOfBandEvidence(projectDir: string, item: CampaignItem): OutOfBandEvidenceInput {
  let ticketStatus: string | undefined;
  let ticketClosedCommit: string | undefined;
  try {
    const ticket = readTicket(projectDir, item.ticketId);
    ticketStatus = ticket.status;
    ticketClosedCommit = ticket.closedCommit;
  } catch {
    // ticket unreadable — facts stay undefined, evidence evaluator reports the gap
  }

  const baseBranch = readConfigString(projectDir, "baseBranch", "main");
  const closedCommitReachableOnBase = ticketClosedCommit
    ? checkClosedCommitReachableOnBase(projectDir, ticketClosedCommit, baseBranch)
    : null;

  let laneEvidence: OutOfBandLaneEvidence | null = null;
  if (ticketClosedCommit) {
    if (commitTouchesOnlyNonCodePaths(projectDir, ticketClosedCommit)) {
      laneEvidence = { kind: "non_code_diff" };
    } else {
      const requiredGate = readConfigString(projectDir, "requiredHostGate", "npm run test:all");
      try {
        // FG-452: ancestry + base-reachability coverage, not exact-sha equality —
        // same rule reconcile-collect.ts's scope-blocked lane uses. FG-440 records
        // the tested CURRENT BASE HEAD (projectDir's HEAD at capture time), which is
        // typically a later commit than ticketClosedCommit itself, so an exact-sha
        // match can never find a reconcile-captured row. checkClosedCommitCoveredByTestedSha
        // proves ticketClosedCommit is an ancestor of the row's testedSha AND that
        // testedSha is itself reachable on the configured base branch — never asserted,
        // always proven by git.
        const rows = queryHostVerificationRowsForGate(item.ticketId, projectDir, requiredGate);
        const covering = rows.filter((r) =>
          checkClosedCommitCoveredByTestedSha(projectDir, ticketClosedCommit!, r.commitSha, baseBranch)
        );
        // Passing-row model (FG-440): any covering PASSING row satisfies the lane,
        // regardless of how many earlier covering rows failed — a historical
        // failure must never permanently outrank a later real pass.
        const recorded = covering.length > 0;
        const passed = covering.some((r) => r.exitCode === 0);
        if (recorded && passed) {
          laneEvidence = { kind: "host_verification", recorded: true, allExitZero: true };
        }
      } catch {
        laneEvidence = null;
      }
    }
  }

  return {
    ticketStatus,
    ticketClosedCommit,
    closedCommitReachableOnBase,
    laneEvidence,
  };
}

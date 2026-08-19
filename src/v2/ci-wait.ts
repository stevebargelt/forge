// FG-731 (Step 2a + 3): the Forge-owned CI WAIT engine — arm (register-before-poll
// or adopt), poll `gh` in the WRITER path, and re-observe on recovery.
//
// This is the ONLY place (besides reconcile's recovery hook, which reuses the SAME
// probe) that talks to `gh` about a wait. The Step-2b derivation only READS the row
// (BD-7/BD-12) — it never probes. Terminal is reached by RE-OBSERVATION of `gh`, not
// by the waiter's own exit: a waiter timeout/cancel leaves the record live for
// recovery, exactly as `forge launch wait` leaves the tmux work untouched (OQ-4).

import { execFileSync } from "node:child_process";
import {
  registerOrAdoptCiWait,
  observeCiWait,
  advanceCiWait,
  renewCiWaitLease,
  readCiWaits,
  getCiWait,
  isTerminalCiWaitState,
  type CiWait,
  type CiWaitKind,
  type CiWaitObservation,
  type CiWaitObservedState,
  type CiWaitRemote,
  type CiWaitResolved,
  type CiWaitAssociation,
  type CiWaitTerminalDisposition,
} from "../store/ci-waits.js";
import { newCiWaitId, nowIso } from "../util/ids.js";
import { storeNowMs } from "../store/publications.js";

// ── the gh boundary (injectable; tests NEVER hit the network) ────────────────

/** One `gh` invocation's result. A `notFound` failure (a resolvable remote that
 *  GitHub reports gone: a 404, a merged/closed PR, a deleted run) is DISTINCT from a
 *  generic failure (auth/binary/indeterminate) — the former resolves the wait to
 *  `abandoned`, the latter is an `unavailable` observation. */
export type GhExecResult =
  | { ok: true; stdout: string }
  | { ok: false; notFound: boolean; reason: string };

export type GhExec = (args: string[], cwd: string | undefined) => GhExecResult;

/** Substrings gh uses when the addressed remote genuinely does not exist — as opposed
 *  to auth/rate/transport failures, which stay `unavailable`. */
function looksNotFound(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("not found") ||
    s.includes("could not resolve to a") ||
    s.includes("no such") ||
    s.includes("404")
  );
}

/** The real gh reader. Agent containers have no `gh` and no credentials (forge runs
 *  on the host), so ENOENT / no-auth fail fast and read as `unavailable`, never a
 *  crash — the same discipline as host-verifications' defaultCheckStatusProvider. */
export const defaultGhExec: GhExec = (args, cwd) => {
  try {
    const stdout = execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string; code?: string };
    const stderr = (err.stderr ? err.stderr.toString() : "") || err.message || "gh invocation failed";
    return { ok: false, notFound: looksNotFound(stderr), reason: stderr.trim().split("\n")[0] ?? "gh failed" };
  }
};

// ── the probe: a wait -> its current gh-observed state ───────────────────────

/** What one probe resolved: the aggregate observation, any run id/url discovered on
 *  first sight (workflow_dispatch/push resolve theirs here), and whether the remote
 *  is gone (→ abandoned). `gone` and an `unavailable` observation never collapse. */
export type CiWaitProbeOutcome = {
  observation: CiWaitObservation;
  resolved?: CiWaitResolved;
  gone?: boolean;
};

export type CiWaitProbe = (wait: CiWait) => CiWaitProbeOutcome;

function repoArgs(wait: CiWait): string[] {
  return wait.repo ? ["--repo", wait.repo] : [];
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** Aggregate a run's jobs into m/n (completed/total). Absent jobs → null/null: the
 *  run is running but the split is unknown, never faked to 0/0. */
function runProgress(jobs: unknown): { m: number | null; n: number | null } {
  if (!Array.isArray(jobs) || jobs.length === 0) return { m: null, n: null };
  const total = jobs.length;
  const done = jobs.filter((j) => (j as { status?: string }).status === "completed").length;
  return { m: done, n: total };
}

/** Observe a resolved Actions run by id (`push_actions`/`workflow_dispatch` once the
 *  id is known). status `completed` → completed; anything else → running (+m/n). */
function probeRunById(wait: CiWait, gh: GhExec): CiWaitProbeOutcome {
  const res = gh(["run", "view", wait.actionsRunId!, ...repoArgs(wait), "--json", "status,conclusion,url,jobs"], wait.projectDir ?? undefined);
  if (!res.ok) {
    if (res.notFound) return { observation: { state: "no_runs" }, gone: true };
    return { observation: { state: "unavailable", reason: res.reason } };
  }
  const json = parseJson(res.stdout) as { status?: string; url?: string; jobs?: unknown } | undefined;
  if (json === undefined) return { observation: { state: "unavailable", reason: "gh run view returned unparseable JSON" } };
  const resolved: CiWaitResolved = { url: json.url ?? null };
  if (json.status === "completed") return { observation: { state: "completed" }, resolved };
  const { m, n } = runProgress(json.jobs);
  return { observation: { state: "running", m, n }, resolved };
}

/** Resolve the run id for a not-yet-bound Actions wait from `gh run list`. `push`
 *  matches on head sha; `workflow_dispatch` matches on the workflow file (+ ref). No
 *  matching run yet → `no_runs` ("nothing has started"), NOT unavailable. */
function probeRunList(wait: CiWait, gh: GhExec): CiWaitProbeOutcome {
  const args = ["run", "list", ...repoArgs(wait), "--json", "databaseId,status,url,headSha,headBranch,event,workflowName", "--limit", "30"];
  if (wait.kind === "workflow_dispatch" && wait.workflowFile) args.push("--workflow", wait.workflowFile);
  const res = gh(args, wait.projectDir ?? undefined);
  if (!res.ok) {
    // A run LIST failure is never "gone": we have nothing to declare gone yet.
    return { observation: { state: "unavailable", reason: res.reason } };
  }
  const rows = parseJson(res.stdout);
  if (!Array.isArray(rows)) return { observation: { state: "unavailable", reason: "gh run list returned unparseable JSON" } };
  const match = rows.find((r) => {
    const row = r as { headSha?: string; headBranch?: string; event?: string };
    if (wait.kind === "push_actions") {
      return (wait.headSha ? row.headSha === wait.headSha : true) && (row.event === undefined || row.event === "push");
    }
    // workflow_dispatch: constrained to the file via --workflow; refine by ref+event.
    return (row.event === undefined || row.event === "workflow_dispatch") && (wait.dispatchRef ? row.headBranch === wait.dispatchRef : true);
  }) as { databaseId?: number | string; status?: string; url?: string } | undefined;
  if (match === undefined) return { observation: { state: "no_runs" } };
  const resolved: CiWaitResolved = { actionsRunId: match.databaseId != null ? String(match.databaseId) : null, url: match.url ?? null };
  if (match.status === "completed") return { observation: { state: "completed" }, resolved };
  return { observation: { state: "running", m: null, n: null }, resolved };
}

/** A PR's head check-suite. A MERGED/CLOSED PR is a resolvable-gone remote (→
 *  abandoned). An empty rollup is `no_runs`; a mixed rollup is running (m/n). */
function probePrChecks(wait: CiWait, gh: GhExec): CiWaitProbeOutcome {
  if (wait.prNumber == null) return { observation: { state: "unavailable", reason: "pr_checks wait has no pr number" } };
  const res = gh(["pr", "view", String(wait.prNumber), ...repoArgs(wait), "--json", "state,url,statusCheckRollup"], wait.projectDir ?? undefined);
  if (!res.ok) {
    if (res.notFound) return { observation: { state: "no_runs" }, gone: true };
    return { observation: { state: "unavailable", reason: res.reason } };
  }
  const json = parseJson(res.stdout) as { state?: string; url?: string; statusCheckRollup?: unknown } | undefined;
  if (json === undefined) return { observation: { state: "unavailable", reason: "gh pr view returned unparseable JSON" } };
  const resolved: CiWaitResolved = { url: json.url ?? null };
  if (json.state === "MERGED" || json.state === "CLOSED") return { observation: { state: "no_runs" }, resolved, gone: true };
  const rollup = Array.isArray(json.statusCheckRollup) ? json.statusCheckRollup : [];
  if (rollup.length === 0) return { observation: { state: "no_runs" }, resolved };
  const total = rollup.length;
  const done = rollup.filter((c) => (c as { status?: string }).status === "COMPLETED").length;
  if (done === total) return { observation: { state: "completed" }, resolved };
  return { observation: { state: "running", m: done, n: total }, resolved };
}

/** The default gh-backed probe. Dispatches on kind; a resolved Actions run id short-
 *  circuits both push_actions and workflow_dispatch to the by-id path. */
export function probeCiWait(wait: CiWait, gh: GhExec = defaultGhExec): CiWaitProbeOutcome {
  switch (wait.kind) {
    case "pr_checks":
      return probePrChecks(wait, gh);
    case "push_actions":
    case "workflow_dispatch":
      return wait.actionsRunId ? probeRunById(wait, gh) : probeRunList(wait, gh);
    default:
      return { observation: { state: "unavailable", reason: `unknown wait kind '${wait.kind}'` } };
  }
}

export const defaultCiWaitProbe: CiWaitProbe = (wait) => probeCiWait(wait, defaultGhExec);

// ── arm: register-before-poll, or adopt a live twin ──────────────────────────

export type ArmCiWaitInput = {
  kind: CiWaitKind;
  remote: CiWaitRemote;
  url?: string | null;
  owner: string;
  leaseMs: number;
  association?: CiWaitAssociation;
};

export type ArmedCiWait = { id: string; adopted: boolean; wait: CiWait };

/** Two live waits share a remote identity when they address the SAME CI run. Adoption
 *  keys on this so a second waiter (a recovered orchestrator) attaches rather than
 *  registering a duplicate — the ci-wait analogue of `forge continue` adopting an
 *  in-flight dispatch by receipt. */
function sameRemoteIdentity(a: CiWait, kind: CiWaitKind, remote: CiWaitRemote): boolean {
  if (a.kind !== kind) return false;
  const repoMatch = (remote.repo ?? null) === a.repo;
  switch (kind) {
    case "pr_checks":
      return repoMatch && remote.prNumber != null && a.prNumber === remote.prNumber;
    case "push_actions":
      if (remote.actionsRunId != null && a.actionsRunId === remote.actionsRunId) return true;
      return repoMatch && remote.headSha != null && a.headSha === remote.headSha;
    case "workflow_dispatch":
      if (remote.actionsRunId != null && a.actionsRunId === remote.actionsRunId) return true;
      return (
        repoMatch &&
        remote.workflowFile != null &&
        a.workflowFile === remote.workflowFile &&
        (remote.dispatchRef ?? null) === a.dispatchRef
      );
    default:
      return false;
  }
}

/** Build the CiWait the waiter proceeds against when the register write itself was a
 *  best-effort miss (the store hiccuped). The wait is unregistered, NOT unwaited: the
 *  loop still probes gh and can reach terminal from re-observation alone. */
function fallbackWait(id: string, input: ArmCiWaitInput, startedAt: string): CiWait {
  const r = input.remote;
  return {
    id,
    kind: input.kind,
    repo: r.repo ?? null,
    actionsRunId: r.actionsRunId ?? null,
    prNumber: r.prNumber ?? null,
    headSha: r.headSha ?? null,
    checkSuiteRef: r.checkSuiteRef ?? null,
    workflowFile: r.workflowFile ?? null,
    dispatchRef: r.dispatchRef ?? null,
    dispatchInputs: typeof r.dispatchInputs === "string" ? r.dispatchInputs : r.dispatchInputs ? JSON.stringify(r.dispatchInputs) : null,
    url: input.url ?? null,
    startedAt,
    lifecycleState: "registered",
    terminal: false,
    terminalDisposition: null,
    observedState: null,
    observedReason: null,
    observedM: null,
    observedN: null,
    observedAt: null,
    owner: input.owner,
    leaseExpiresAtMs: null,
    runId: input.association?.runId ?? null,
    ticketId: input.association?.ticketId ?? null,
    projectDir: input.association?.projectDir ?? null,
    projectDirCanonical: null,
  };
}

/** ADOPT a live twin, else REGISTER a fresh wait — ATOMICALLY and synchronously, BEFORE
 *  any gh call. The find-twin read, the INSERT, and the lease all run in ONE store
 *  transaction (registerOrAdoptCiWait), so two processes arming the same run cannot both
 *  register a duplicate (RF-1). The write is best-effort: on a store hiccup it returns
 *  unregistered, and we HONOR that by degrading to an unregistered fallback wait — never a
 *  second unguarded write that would re-throw on the same busy store and abort the waiter
 *  before it can poll gh (RF-6). The wait is unregistered, NOT unwaited. */
export function armCiWait(input: ArmCiWaitInput): ArmedCiWait {
  const id = newCiWaitId();
  const startedAt = nowIso();
  const result = registerOrAdoptCiWait(
    {
      id,
      kind: input.kind,
      remote: input.remote,
      url: input.url ?? null,
      startedAt,
      owner: input.owner,
      leaseMs: input.leaseMs,
      association: input.association,
    },
    (candidate) => sameRemoteIdentity(candidate, input.kind, input.remote),
  );
  if (!result.registered) return { id, adopted: false, wait: fallbackWait(id, input, startedAt) };
  return { id: result.wait.id, adopted: result.adopted, wait: result.wait };
}

// ── the block-wait loop: single terminal outcome, by re-observation ──────────

/** The single terminal outcome a wait emits — mirrors `forge launch wait`'s one-shot
 *  observation. `completed_awaiting_advance` and `abandoned` are RECORD terminals
 *  reached by re-observing gh; `timeout`/`cancelled` are WAITER outcomes that leave
 *  the record live for recovery (they never terminalize it — invariant 1). */
export type CiWaitOutcome =
  | { kind: "completed_awaiting_advance"; id: string; wait: CiWait }
  | { kind: "abandoned"; id: string; wait: CiWait }
  | { kind: "cancelled"; id: string; lastObserved: CiWaitObservedState | null }
  | { kind: "timeout"; id: string; lastObserved: CiWaitObservedState | null };

/** A record whose lifecycle already reached a RECORD terminal (someone cancelled it,
 *  or a prior probe abandoned it) maps straight to its outcome — the first
 *  disposition wins, and the loop must stop. */
function recordTerminalOutcome(wait: CiWait): CiWaitOutcome | null {
  if (wait.lifecycleState === "completed_awaiting_advance") return { kind: "completed_awaiting_advance", id: wait.id, wait };
  if (isTerminalCiWaitState(wait.lifecycleState)) {
    // advanced/cancelled/abandoned. `advanced` shouldn't stop a fresh waiter as a
    // failure, but it IS terminal — report it as completed_awaiting_advance's sibling.
    if (wait.terminalDisposition === "abandoned") return { kind: "abandoned", id: wait.id, wait };
    return { kind: "cancelled", id: wait.id, lastObserved: wait.observedState };
  }
  return null;
}

export type CiWaitLoopDeps = {
  probe: CiWaitProbe;
  owner: string;
  leaseMs: number;
  intervalMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injectable for tests: a delay that resolves early on abort. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable clock for the deadline; defaults to Date.now. */
  now?: () => number;
};

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** ONE observation step: probe gh, write it through the store, and decide whether the
 *  record reached a terminal. Returns the outcome on terminal, else null (keep
 *  waiting). All gh probing for the wait happens HERE (writer path). */
export function stepCiWait(idOrWait: string | CiWait, probe: CiWaitProbe): CiWaitOutcome | null {
  const current = typeof idOrWait === "string" ? getCiWait(idOrWait) : (getCiWait(idOrWait.id) ?? idOrWait);
  if (current === undefined) return null; // unregistered + no fallback: caller retries with a fallback wait
  const already = recordTerminalOutcome(current);
  if (already) return already;

  const result = probe(current);
  const observedAt = nowIso();
  if (result.gone) {
    advanceCiWait(current.id, "abandoned");
    const wait = getCiWait(current.id) ?? { ...current, lifecycleState: "abandoned", terminal: true, terminalDisposition: "abandoned" as CiWaitTerminalDisposition };
    return { kind: "abandoned", id: current.id, wait };
  }
  observeCiWait(current.id, result.observation, observedAt, result.resolved);
  const after = getCiWait(current.id);
  if (after && after.lifecycleState === "completed_awaiting_advance") return { kind: "completed_awaiting_advance", id: current.id, wait: after };
  if (after) {
    const t = recordTerminalOutcome(after);
    if (t) return t;
  }
  // Store-less fallback: the run reported completed but the write no-op'd (unregistered).
  if (after === undefined && result.observation.state === "completed") {
    return { kind: "completed_awaiting_advance", id: current.id, wait: { ...current, lifecycleState: "completed_awaiting_advance", observedState: "completed" } };
  }
  return null;
}

/** Block until the wait reaches a terminal disposition by RE-OBSERVATION, then return
 *  exactly one outcome. A timeout or an aborted signal returns the WAITER outcome and
 *  leaves the record live — recovery (reconcileCiWaits) re-observes it later. */
export async function runCiWaitLoop(armed: ArmedCiWait, deps: CiWaitLoopDeps): Promise<CiWaitOutcome> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => Date.now());
  const deadline = deps.timeoutMs === Infinity ? Infinity : now() + deps.timeoutMs;
  let lastObserved: CiWaitObservedState | null = armed.wait.observedState;

  for (;;) {
    if (deps.signal?.aborted) return { kind: "cancelled", id: armed.id, lastObserved };
    renewCiWaitLease(armed.id, deps.owner, deps.leaseMs);
    const outcome = stepCiWait(getCiWait(armed.id) ?? armed.wait, deps.probe);
    if (outcome) return outcome;
    lastObserved = getCiWait(armed.id)?.observedState ?? lastObserved;
    if (now() >= deadline) return { kind: "timeout", id: armed.id, lastObserved };
    await sleep(deps.intervalMs, deps.signal);
    if (deps.signal?.aborted) return { kind: "cancelled", id: armed.id, lastObserved };
    if (now() >= deadline) return { kind: "timeout", id: armed.id, lastObserved };
  }
}

// ── recovery: re-observe a dead waiter's wait (Step 3) ───────────────────────

export type CiWaitRecoveryChange = {
  id: string;
  from: string;
  to: string;
  observedState: CiWaitObservedState | null;
};

/** Re-observe every NON-TERMINAL wait whose lease has expired (waiter presumed dead),
 *  advancing it to whatever `gh` now reports. An expired lease NEVER by itself
 *  terminalizes the wait (invariant 1) — terminal comes ONLY from re-observation
 *  (`completed_awaiting_advance`, or `abandoned` on a gone remote). A wait with a live
 *  lease is skipped: its waiter is probing it. This is the SAME mechanism as
 *  terminal-reachability — recovery IS re-observation.
 *
 *  FG-590 boundary: this reaps NOTHING. `completed_awaiting_advance` is a legitimate
 *  non-terminal state (an advance is owed), not a leak. */
export function reconcileCiWaits(
  probe: CiWaitProbe = defaultCiWaitProbe,
  nowMs: () => number = defaultNowMs,
): CiWaitRecoveryChange[] {
  const changes: CiWaitRecoveryChange[] = [];
  const now = nowMs();
  for (const wait of readCiWaits({ liveOnly: true })) {
    const lease = wait.leaseExpiresAtMs;
    const expired = lease === null || lease <= now;
    if (!expired) continue; // a live waiter owns the poll; do not double-probe
    const from = wait.lifecycleState;
    const result = probe(wait);
    if (result.gone) {
      advanceCiWait(wait.id, "abandoned");
    } else {
      observeCiWait(wait.id, result.observation, nowIso(), result.resolved);
    }
    const after = getCiWait(wait.id);
    if (after && after.lifecycleState !== from) {
      changes.push({ id: wait.id, from, to: after.lifecycleState, observedState: after.observedState });
    }
  }
  return changes;
}

// Deferred so the store clock is read lazily (never at module load) — mirrors the
// store's own storeNowMs discipline.
function defaultNowMs(): number {
  return storeNowMs();
}

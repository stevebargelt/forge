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
  reapCiWait,
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

type RunListRow = {
  databaseId?: number | string;
  status?: string;
  url?: string;
  headSha?: string;
  headBranch?: string;
  event?: string;
  createdAt?: string;
};

/** RF-2: a `workflow_dispatch` wait must never claim a run the orchestrator did not
 *  trigger. Before its own run id resolves, all we can match on is workflow/ref/event —
 *  which a PRIOR or concurrent dispatch of the SAME workflow on the SAME ref also
 *  satisfies, so a naive first-match could attach to an unrelated run and report its
 *  completion as ours. Bound the candidate set by the registration time: `ci_waits`
 *  records `started_at` register-before-poll, so only a run CREATED at/after this wait
 *  was registered can plausibly be the one it triggered — never one that predates
 *  registration. Among the survivors, the EARLIEST post-registration run wins (the one
 *  this registration most plausibly kicked off).
 *
 *  Predicate: event ∈ {workflow_dispatch, ⊥} ∧ (ref matches when recorded) ∧
 *  createdAt ≥ started_at (strict, no skew slack), then min(createdAt).
 *
 *  RF-3 (dispatch inputs / accepted residual): GitHub exposes NO per-run
 *  workflow_dispatch inputs on either read we have — `gh run list` and `gh run view
 *  --json` both omit an `inputs` field — so the dispatch inputs CANNOT be a correlation
 *  key here, even though we store them. The stored `dispatch_inputs` are therefore not
 *  dead state: they are the durable REQUEST evidence of what this wait dispatched (the
 *  ci_waits row is the recoverable identity record), retained for audit/recovery, not
 *  for run selection. With inputs unavailable, workflow/ref/event + the created-at bound
 *  are the only discriminators. The accepted residual: two CONCURRENT dispatches of the
 *  IDENTICAL workflow on the IDENTICAL ref, BOTH created after this registration, are
 *  indistinguishable — min(createdAt) picks the earlier, which may not be ours. This is
 *  accepted because this single-user orchestrator does not fire two identical dispatches
 *  of the same workflow/ref concurrently; a naive first-match (the original RF-2 bug)
 *  could attach to a PRIOR unrelated run, which the created-at bound rules out.
 *
 *  A row without a createdAt cannot be proven post-registration and is never selected. */
function matchDispatchRun(wait: CiWait, rows: RunListRow[]): RunListRow | undefined {
  const registeredMs = new Date(wait.startedAt).getTime();
  const candidates = rows.filter((row) => {
    if (row.event !== undefined && row.event !== "workflow_dispatch") return false;
    if (wait.dispatchRef && row.headBranch !== wait.dispatchRef) return false;
    if (row.createdAt === undefined) return false;
    return new Date(row.createdAt).getTime() >= registeredMs;
  });
  candidates.sort((a, b) => new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime());
  return candidates[0];
}

/** Resolve the run id for a not-yet-bound Actions wait from `gh run list`. `push`
 *  matches on head sha; `workflow_dispatch` matches on the workflow file (+ ref) AND
 *  the registration-time bound (see matchDispatchRun / RF-2). No matching run yet →
 *  `no_runs` ("nothing has started"), NOT unavailable. */
function probeRunList(wait: CiWait, gh: GhExec): CiWaitProbeOutcome {
  const args = ["run", "list", ...repoArgs(wait), "--json", "databaseId,status,url,headSha,headBranch,event,workflowName,createdAt", "--limit", "30"];
  if (wait.kind === "workflow_dispatch" && wait.workflowFile) args.push("--workflow", wait.workflowFile);
  const res = gh(args, wait.projectDir ?? undefined);
  if (!res.ok) {
    // A run LIST failure is never "gone": we have nothing to declare gone yet.
    return { observation: { state: "unavailable", reason: res.reason } };
  }
  const rows = parseJson(res.stdout);
  if (!Array.isArray(rows)) return { observation: { state: "unavailable", reason: "gh run list returned unparseable JSON" } };
  const match =
    wait.kind === "push_actions"
      ? (rows as RunListRow[]).find((row) => (wait.headSha ? row.headSha === wait.headSha : true) && (row.event === undefined || row.event === "push"))
      : matchDispatchRun(wait, rows as RunListRow[]);
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

/** Best-effort store access on the WAIT path (RF-2, residual of RF-6). The durable
 *  ci_waits row is an OBSERVABILITY layer, never a gate on the wait: register-before-poll
 *  is best-effort, and terminal authority for the waiter comes from the gh probe, not the
 *  store. A PERSISTENT store failure (a busy/broken/absent DB) must degrade to gh-only
 *  polling — never throw and abort the waiter before it can observe CI. Every store read/
 *  write in the loop and this step is funneled through here so one broken store cannot
 *  kill the wait. */
function bestEffortStore<T>(op: () => T, fallback: T): T {
  try {
    return op();
  } catch {
    return fallback;
  }
}

/** ONE observation step: probe gh, write it through the store, and decide whether the
 *  record reached a terminal. Returns the outcome on terminal, else null (keep
 *  waiting). All gh probing for the wait happens HERE (writer path). Every store touch is
 *  best-effort (RF-2): a broken store falls through to gh-only resolution, never throws. */
export function stepCiWait(idOrWait: string | CiWait, probe: CiWaitProbe): CiWaitOutcome | null {
  const fallback = typeof idOrWait === "string" ? undefined : idOrWait;
  const id = typeof idOrWait === "string" ? idOrWait : idOrWait.id;
  const current = bestEffortStore(() => getCiWait(id), undefined) ?? fallback;
  if (current === undefined) return null; // unregistered + no fallback: caller retries with a fallback wait
  const already = recordTerminalOutcome(current);
  if (already) return already;

  const result = probe(current);
  const observedAt = nowIso();
  if (result.gone) {
    bestEffortStore(() => advanceCiWait(current.id, "abandoned"), false);
    const wait = bestEffortStore(() => getCiWait(current.id), undefined) ?? { ...current, lifecycleState: "abandoned", terminal: true, terminalDisposition: "abandoned" as CiWaitTerminalDisposition };
    return { kind: "abandoned", id: current.id, wait };
  }
  bestEffortStore(() => observeCiWait(current.id, result.observation, observedAt, result.resolved), false);
  const after = bestEffortStore(() => getCiWait(current.id), undefined);
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
    // RF-2: the lease renewal is the loop's FIRST store write — best-effort, exactly like
    // register-before-poll. A persistent store failure here must NOT throw and abort the
    // waiter before its first gh probe; degrade to fallback (unregistered) polling instead.
    bestEffortStore(() => renewCiWaitLease(armed.id, deps.owner, deps.leaseMs), false);
    const outcome = stepCiWait(bestEffortStore(() => getCiWait(armed.id), undefined) ?? armed.wait, deps.probe);
    if (outcome) return outcome;
    lastObserved = bestEffortStore(() => getCiWait(armed.id), undefined)?.observedState ?? lastObserved;
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

/** The run/project scope a reconcile pass is permitted to re-observe (RF-1/RF-4).
 *  Recovery is hooked in reconcile, and a reconcile stays scoped to the run set it is
 *  reconciling — so a workspace- or single-run reconcile must NEVER `gh`-probe or mutate
 *  waits outside that scope (that would reach into other workspaces' waits). A wait is in
 *  scope when it is tied to one of these runs (`runId`) OR sits in one of these projects
 *  (`projectDirs`, matched against the wait's canonical project) — the latter so a
 *  runless, project/ticket-only wait in the reconciled workspace still recovers.
 *  `projectDirs` are expected already-canonical (provenPhysical), to match
 *  `projectDirCanonical`; the verbatim `projectDir` is a fallback for rows with no
 *  canonical. An empty scope matches NOTHING — recovery is never implicitly host-wide. */
export type CiWaitReconcileScope = {
  runIds?: readonly string[];
  projectDirs?: readonly string[];
};

function waitInReconcileScope(wait: CiWait, scope: CiWaitReconcileScope): boolean {
  if (wait.runId != null && scope.runIds?.includes(wait.runId)) return true;
  if (scope.projectDirs && scope.projectDirs.length > 0) {
    if (wait.projectDirCanonical != null && scope.projectDirs.includes(wait.projectDirCanonical)) return true;
    if (wait.projectDir != null && scope.projectDirs.includes(wait.projectDir)) return true;
  }
  return false;
}

/** Re-observe every NON-TERMINAL wait whose lease has expired (waiter presumed dead),
 *  advancing it to whatever `gh` now reports. An expired lease NEVER by itself
 *  terminalizes the wait (invariant 1) — terminal comes ONLY from re-observation
 *  (`completed_awaiting_advance`, or `abandoned` on a gone remote). A wait with a live
 *  lease is skipped: its waiter is probing it. This is the SAME mechanism as
 *  terminal-reachability — recovery IS re-observation.
 *
 *  FG-590 boundary: this reaps NOTHING. `completed_awaiting_advance` is a legitimate
 *  non-terminal state (an advance is owed), not a leak.
 *
 *  RF-1/RF-4: `scope` bounds which waits this pass may touch to the run/project set the
 *  calling reconcile is reconciling — an unscoped, host-wide sweep would probe and mutate
 *  every other workspace's waits. */
export function reconcileCiWaits(
  scope: CiWaitReconcileScope,
  probe: CiWaitProbe = defaultCiWaitProbe,
  nowMs: () => number = defaultNowMs,
): CiWaitRecoveryChange[] {
  const changes: CiWaitRecoveryChange[] = [];
  const now = nowMs();
  for (const wait of readCiWaits({ liveOnly: true })) {
    if (!waitInReconcileScope(wait, scope)) continue; // RF-4: never touch out-of-scope waits
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

// ── FG-755: reap push_actions waits stranded at no_runs by a dead waiter ──────

/** The persistence bound behind "DURABLE no_runs". A push-triggered Actions run appears
 *  within a couple of minutes of the push, so a push_actions wait that has STILL matched
 *  no run this long after it was registered is the durable-no_runs shape (e.g. a squash-
 *  merge commit whose push-triggered run the head-sha query never matches), not a run
 *  still arming. Set well above the minutes a real run takes to surface, so a genuinely
 *  in-flight wait is never mistaken for stranded. */
export const PUSH_ACTIONS_NO_RUNS_DURABLE_MS = 30 * 60 * 1000;

/** One wait the reaper identified (dry-run: WOULD reap; real run: DID reap), carrying the
 *  exact identity FG-755 AC3 requires the dry-run listing to surface before any mutation. */
export type CiWaitReapCandidate = {
  id: string;
  kind: CiWaitKind;
  headSha: string | null;
  owner: string | null;
  observedState: CiWaitObservedState | null;
  ageMs: number;
  reason: string;
};

export type CiWaitReapOutcome = {
  dryRun: boolean;
  /** dry-run: the waits that WOULD be reaped; real run: the waits actually reaped. */
  reaped: CiWaitReapCandidate[];
};

/** FG-755: reap push_actions CI-waits stranded at `no_runs` by a dead waiter. A wait is
 *  reaped to the `abandoned` terminal (row PRESERVED, with a durable observed_reason) ONLY
 *  when ALL of these hold — NEITHER load-bearing gate reaps alone:
 *    1. kind === push_actions (this ticket's shape; other kinds are untouched);
 *    2. DEAD OWNER — the lease is expired (leaseExpiresAtMs <= now, or never set). This is
 *       the SAME dead-waiter proxy reconcileCiWaits uses, not a new liveness probe;
 *    3. DURABLE no_runs — the last observation is `no_runs` AND the wait has existed past
 *       PUSH_ACTIONS_NO_RUNS_DURABLE_MS (persistence from the existing started_at). A single
 *       TRANSIENT no_runs on a young wait is never reaped.
 *  A fresh probe is then required to STILL report no_runs — a fail-safe so a wait whose run
 *  actually exists now (a stale no_runs observation) is left for recovery to re-observe
 *  rather than wrongly abandoned. Unlike reconcileCiWaits' scoped sweep this is deliberately
 *  operator-invoked and scans host-wide live push_actions waits.
 *
 *  Respects the FG-590 boundary: a `completed_awaiting_advance` is a legitimate non-terminal
 *  state and is NEVER reaped (its observed_state is `completed`, not `no_runs`), and a wait
 *  with a live lease is never touched (its waiter is still probing it). */
export function reapStuckCiWaits(
  opts: { dryRun: boolean },
  probe: CiWaitProbe = defaultCiWaitProbe,
  nowMs: () => number = defaultNowMs,
): CiWaitReapOutcome {
  const now = nowMs();
  const boundMinutes = Math.round(PUSH_ACTIONS_NO_RUNS_DURABLE_MS / 60000);
  const reaped: CiWaitReapCandidate[] = [];
  for (const wait of readCiWaits({ liveOnly: true })) {
    if (wait.kind !== "push_actions") continue; // FG-755 scope
    const lease = wait.leaseExpiresAtMs;
    const deadOwner = lease === null || lease <= now; // same signal as reconcileCiWaits
    if (!deadOwner) continue; // AC2: a live-lease wait is never reaped
    if (wait.observedState !== "no_runs") continue; // only the no_runs shape
    const ageMs = now - new Date(wait.startedAt).getTime();
    if (ageMs < PUSH_ACTIONS_NO_RUNS_DURABLE_MS) continue; // AC2: transient no_runs is never reaped
    // Fail-safe: confirm the run genuinely still does not exist before abandoning it.
    if (probe(wait).observation.state !== "no_runs") continue;
    const reason = `no matching CI run found within ${boundMinutes}m of push; waiter dead — reaped by ci-wait reap`;
    if (!opts.dryRun && !reapCiWait(wait.id, reason)) continue; // lost a race to another terminal
    reaped.push({
      id: wait.id,
      kind: wait.kind,
      headSha: wait.headSha,
      owner: wait.owner,
      observedState: wait.observedState,
      ageMs,
      reason,
    });
  }
  return { dryRun: opts.dryRun, reaped };
}

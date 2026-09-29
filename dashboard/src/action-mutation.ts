// FG-822 — THE DASHBOARD'S TASK ACTIONS: gate decisions, policy-safe retry and the
// adopt-preserving recover re-drive, as a SECOND closed registry beside the queue
// planning one (queue-mutation.ts). Same DEC-015 shape: each route shells EXACTLY ONE
// named `forge` verb with a fixed argv, writes no DB row itself, and runs behind every
// guard in mutation-guards.ts (loopback bind, same-origin, non-simple content type,
// argv array with leading-dash rejection).
//
// ─── ELIGIBILITY IS DECIDED HERE, BEFORE THE CLI IS ASKED ───────────────────
// The CLI stays the authority — it re-checks everything — but a button the CLI would
// refuse, or one whose refusal depends on a human precondition, must never be offered.
// So every route first runs the same PREVIEW `GET /api/task/:id/actions` returns:
//
//  * gate      — only a task at `awaiting_gate`. A rationale is required for every
//                decision; the dashboard never passes `--force`, so a blocked_by_red
//                task (which needs it) is refused here, not offered.
//  * retry     — only a FAILED task whose recorded failure kind has a POLICY row that
//                is `retryable: true` with NO advice. A kind with advice needs a human
//                precondition first (refresh auth, fix a clone), and a kind this build
//                does not know is refused — `retryPolicy()`'s permissive default is
//                advisory prose, never a mutation guard. Also only a runner-stamped
//                workflow step: an ad-hoc retry dispatches its container INSIDE the
//                forge process, which this surface's bounded child would kill.
//  * recover-re-drive — only a FAILED task whose kind RE_DRIVABLE_FAILURE_KINDS (the
//                fail-closed guard `forge recover --re-drive` itself reads) accepts.
//
// ─── WHAT IS NOT HERE, AND CANNOT BE REACHED FROM HERE ───────────────────────
// Arming or disarming the dispatcher, max_active_runs, cancel, next, routing/RACI/
// model-policy apply, backlog edits, and any `--force`. The verb set is a closed
// exported constant, the argv builder can emit nothing outside it, and a test asserts
// both over the table rather than trusting this comment.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isReDrivableFailureKind, recordedRetryDisposition, retryPolicy } from "@forge/retry-policy";
import type { TaskActionFacts } from "./queries.js";
import {
  CHILD_TIMEOUT_MS,
  MAX_CONCURRENT_MUTATIONS,
  MAX_REPORTED_STDERR,
  assertOperand,
  guardMutationPost,
  isRefusal,
  readBody,
  refuse,
  resolveForgeBinary,
  runForgeVerb,
  send,
  withMutationSlot,
  type MutationRefusal,
} from "./mutation-guards.js";

// ─── the route table ─────────────────────────────────────────────────────────

/** The task-action routes, as a CLOSED table: one row per action, each naming the
 *  ONE `forge` verb it shells. */
export const ACTION_ROUTES = {
  gate: { path: "/api/task/:id/gate", verb: "gate" },
  retry: { path: "/api/task/:id/retry", verb: "retry" },
  "recover-re-drive": { path: "/api/task/:id/recover-re-drive", verb: "recover" },
} as const;

export type TaskAction = keyof typeof ACTION_ROUTES;

/** The ONLY `forge` verbs this registry can ever spawn. */
export const ACTION_FORGE_VERBS = ["gate", "retry", "recover"] as const;

export type ActionForgeVerb = (typeof ACTION_FORGE_VERBS)[number];

export const GATE_DECISIONS = ["advance", "reject", "request-changes"] as const;

export type GateDecision = (typeof GATE_DECISIONS)[number];

/** Recorded server-side as the decider, as classify records its actor: the honest,
 *  unforgeable fact that the decision came through this surface. */
export const ACTION_ACTOR = "dashboard";

const ACTION_PATH = /^\/api\/task\/([^/]+)\/(gate|retry|recover-re-drive)$/;
const PREVIEW_PATH = /^\/api\/task\/([^/]+)\/actions$/;

/** A task id: a charset that cannot express a leading `-`, a path separator, `..`, a
 *  shell metacharacter or whitespace. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const MAX_RATIONALE_CHARS = 4000;
const MAX_ACTION_BODY_BYTES = 16 * 1024;

export function isActionMutationPath(path: string): boolean {
  return ACTION_PATH.test(path);
}

/** The raw task-id segment of a preview path, or null. */
export function actionPreviewTaskId(path: string): string | null {
  const m = path.match(PREVIEW_PATH);
  return m ? m[1]! : null;
}

export function taskIdOperand(raw: string): string | MutationRefusal {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return refuse(400, "the task id is not valid URI encoding.");
  }
  const dash = assertOperand(value, "the task id");
  if (dash) return dash;
  if (!TASK_ID.test(value)) return refuse(400, `the task id ${JSON.stringify(value)} is not a task id.`);
  return value;
}

// ─── the preview ─────────────────────────────────────────────────────────────

export type EligibleAction = {
  action: TaskAction;
  decision: GateDecision | null;
  /** The command, as the operator would type it — the button's label. */
  verb: string;
  /** The exact argv the route spawns (the rationale as a placeholder). */
  argv: string[];
  reason: string;
  requiresRationale: boolean;
  route: string;
};

export type RefusedAction = {
  action: TaskAction;
  verb: string;
  reason: string;
  advice: string | null;
};

export type ActionPreview = {
  taskId: string;
  status: string;
  failureKind: string | null;
  eligible: EligibleAction[];
  refused: RefusedAction[];
};

const RATIONALE_PLACEHOLDER = "<rationale>";

function routeFor(action: TaskAction, taskId: string): string {
  return ACTION_ROUTES[action].path.replace(":id", encodeURIComponent(taskId));
}

function argvFor(action: TaskAction, taskId: string, decision: GateDecision | null, rationale: string): string[] {
  switch (action) {
    case "gate":
      return ["gate", taskId, decision!, "--rationale", rationale, "--decided-by", ACTION_ACTOR];
    case "retry":
      return ["retry", taskId];
    case "recover-re-drive":
      return ["recover", taskId, "--re-drive"];
  }
}

function verbFor(action: TaskAction, taskId: string, decision: GateDecision | null): string {
  switch (action) {
    case "gate":
      return `forge gate ${taskId} ${decision ?? "<decision>"}`;
    case "retry":
      return `forge retry ${taskId}`;
    case "recover-re-drive":
      return `forge recover ${taskId} --re-drive`;
  }
}

function eligible(action: TaskAction, taskId: string, reason: string, decision: GateDecision | null = null): EligibleAction {
  return {
    action,
    decision,
    verb: verbFor(action, taskId, decision),
    argv: argvFor(action, taskId, decision, RATIONALE_PLACEHOLDER),
    reason,
    requiresRationale: action === "gate",
    route: routeFor(action, taskId),
  };
}

function refused(action: TaskAction, taskId: string, reason: string, advice: string | null = null): RefusedAction {
  return { action, verb: verbFor(action, taskId, null), reason, advice };
}

/** PURE: which actions this task admits right now, and why the others are refused. */
export function previewTaskActions(facts: Pick<TaskActionFacts, "taskId" | "status" | "failureKind" | "dispatchSource">): ActionPreview {
  const { taskId, status } = facts;
  const kind = facts.failureKind ?? null;
  const out: ActionPreview = { taskId, status, failureKind: kind, eligible: [], refused: [] };

  if (status === "awaiting_gate") {
    for (const decision of GATE_DECISIONS) {
      out.eligible.push(eligible("gate", taskId, "the task is awaiting a gate decision; the rationale is recorded with it", decision));
    }
  } else {
    out.refused.push(refused("gate", taskId, `the task is ${status}; only a task awaiting_gate takes a gate decision here`));
  }

  if (status !== "failed") {
    out.refused.push(refused("retry", taskId, `the task is ${status}; only a failed task is retried`));
    out.refused.push(refused("recover-re-drive", taskId, `the task is ${status}; only a failed task is re-driven`));
    return out;
  }

  const disposition = recordedRetryDisposition(kind);
  // The advice with <id> filled in, for this task — prose only, never an eligibility input.
  const advice = kind !== null && disposition?.advice ? retryPolicy(kind, taskId).advice ?? null : null;
  if (kind === null) {
    out.refused.push(refused("retry", taskId, "no failure kind is recorded, so the retry policy has nothing to decide on", `inspect it first: forge show ${taskId}`));
  } else if (!disposition) {
    out.refused.push(refused("retry", taskId, `the failure kind '${kind}' is not in this build's retry policy`, `inspect it first: forge show ${taskId}`));
  } else if (!disposition.retryable) {
    out.refused.push(refused("retry", taskId, `${kind} is not retryable: ${disposition.reason}`, advice));
  } else if (advice !== null) {
    out.refused.push(refused("retry", taskId, `${kind} needs a human precondition before a retry`, advice));
  } else if (facts.dispatchSource !== "workflow") {
    out.refused.push(refused(
      "retry",
      taskId,
      "this task is not a runner-stamped workflow step, and retrying an ad-hoc task dispatches its container inside the forge process",
      `run it from a terminal: forge retry ${taskId}`,
    ));
  } else {
    out.eligible.push(eligible("retry", taskId, `${kind}: ${disposition.reason}`));
  }

  if (isReDrivableFailureKind(kind ?? undefined)) {
    out.eligible.push(eligible("recover-re-drive", taskId, `${kind} is a wave-level stop the adopt-preserving re-drive accepts`));
  } else {
    out.refused.push(refused(
      "recover-re-drive",
      taskId,
      kind === null ? "no failure kind is recorded; the re-drive guard fails closed" : `${kind} is not a failure kind the re-drive accepts`,
    ));
  }
  return out;
}

// ─── the argv, before any of it reaches a child ──────────────────────────────

export type BuiltAction = { ok: true; verb: ActionForgeVerb; argv: string[]; eligible: EligibleAction };

/** THE ARGV BUILDER. The body is checked against the one shape each action takes,
 *  eligibility is re-decided from the preview, and only then is argv assembled. */
export function buildActionArgv(
  action: TaskAction,
  facts: Pick<TaskActionFacts, "taskId" | "status" | "failureKind" | "dispatchSource">,
  body: unknown,
): BuiltAction | MutationRefusal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse(400, "the request body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  const allowed = action === "gate" ? ["decision", "rationale"] : [];
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    return refuse(400, `${ACTION_ROUTES[action].path} takes ${allowed.length ? allowed.join(" and ") : "no fields"}; refusing ${extra.join(", ")}. The dashboard never passes --force.`);
  }

  let decision: GateDecision | null = null;
  let rationale = "";
  if (action === "gate") {
    const rawDecision = input["decision"];
    if (typeof rawDecision !== "string" || !(GATE_DECISIONS as readonly string[]).includes(rawDecision)) {
      return refuse(400, `decision must be one of ${GATE_DECISIONS.join(", ")} (got ${JSON.stringify(rawDecision)}).`);
    }
    decision = rawDecision as GateDecision;
    const rawRationale = input["rationale"];
    if (typeof rawRationale !== "string" || rawRationale.trim() === "") {
      return refuse(400, "rationale is required for every gate decision: it is the human decision record.");
    }
    if (rawRationale.length > MAX_RATIONALE_CHARS) return refuse(400, `rationale must be at most ${MAX_RATIONALE_CHARS} characters.`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(rawRationale)) return refuse(400, "rationale must not contain control characters.");
    const dash = assertOperand(rawRationale.trimStart(), "rationale");
    if (dash) return dash;
    rationale = rawRationale;
  }

  const preview = previewTaskActions(facts);
  const match = preview.eligible.find((e) => e.action === action && e.decision === decision);
  if (!match) {
    const why = preview.refused.find((r) => r.action === action);
    const reason = why ? why.reason : `${verbFor(action, facts.taskId, decision)} is not eligible for this task`;
    return refuse(409, why?.advice ? `${reason}. ${why.advice}` : reason);
  }

  const argv = argvFor(action, facts.taskId, decision, rationale);
  return { ok: true, verb: ACTION_ROUTES[action].verb, argv, eligible: match };
}

// ─── the handler ─────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = resolve(HERE, "..");

export type ActionMutationContext = {
  /** Resolved only after every header guard has passed. */
  lookupTask: (taskId: string) => TaskActionFacts | null;
};

/** Handle one POST to a task-action route. The ORDER is the security property: every
 *  refusal happens before a subprocess is resolved, let alone spawned. */
export async function handleActionMutation(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: ActionMutationContext,
): Promise<void> {
  const m = path.match(ACTION_PATH);
  if (!m) {
    send(res, 404, { ok: false, error: "not found" });
    return;
  }
  const action = m[2] as TaskAction;

  const headerRefusal = guardMutationPost(req, "task actions");
  if (headerRefusal) {
    send(res, headerRefusal.status, { ok: false, action, error: headerRefusal.error });
    return;
  }

  const taskId = taskIdOperand(m[1]!);
  if (isRefusal(taskId)) {
    send(res, taskId.status, { ok: false, action, error: taskId.error });
    return;
  }

  const body = await readBody(req, MAX_ACTION_BODY_BYTES);
  if (isRefusal(body)) {
    send(res, body.status, { ok: false, action, error: body.error });
    return;
  }
  let parsed: unknown;
  try {
    parsed = body.text.trim() === "" ? {} : JSON.parse(body.text);
  } catch {
    send(res, 400, { ok: false, action, error: "the request body is not valid JSON." });
    return;
  }

  const facts = context.lookupTask(taskId);
  if (!facts) {
    send(res, 404, { ok: false, action, error: `no task ${taskId}.` });
    return;
  }

  const built = buildActionArgv(action, facts, parsed);
  if (isRefusal(built)) {
    send(res, built.status, { ok: false, action, error: built.error });
    return;
  }
  // Belt and braces over the closed set: the builder is the only producer.
  if (!(ACTION_FORGE_VERBS as readonly string[]).includes(built.argv[0]!) || built.argv[0] !== built.verb || built.argv.includes("--force")) {
    send(res, 500, { ok: false, action, error: `refusing to spawn an unregistered action argv (${built.argv[0]}).` });
    return;
  }

  const binary = resolveForgeBinary();
  if (isRefusal(binary)) {
    send(res, binary.status, { ok: false, action, error: binary.error });
    return;
  }

  // The run's own checkout (read from the store, never the request) when it still
  // exists; the dashboard's directory otherwise. These verbs resolve the task by id.
  const cwd = facts.projectDir && isAbsolute(facts.projectDir) && existsSync(facts.projectDir) ? facts.projectDir : DASHBOARD_DIR;
  const verb = built.eligible.verb;
  const result = await withMutationSlot(() => runForgeVerb(binary.path, built.argv, cwd));
  if (result === null) {
    send(res, 503, { ok: false, action, verb, error: `too many dashboard mutations in flight (${MAX_CONCURRENT_MUTATIONS}); retry in a moment.` });
    return;
  }
  const summary = {
    action,
    verb,
    exitCode: result.code,
    stdout: result.stdout.slice(-MAX_REPORTED_STDERR).trim(),
    stderr: result.stderr.slice(-MAX_REPORTED_STDERR).trim(),
  };
  if (result.timedOut) {
    send(res, 504, { ok: false, ...summary, error: `\`${verb}\` did not finish within ${CHILD_TIMEOUT_MS}ms.` });
    return;
  }
  if (result.code !== 0) {
    send(res, 409, { ok: false, ...summary, error: summary.stderr || summary.stdout || `\`${verb}\` exited ${result.code}` });
    return;
  }
  send(res, 200, { ok: true, ...summary });
}

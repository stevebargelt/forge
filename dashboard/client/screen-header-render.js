// FG-821: the screen contract, as data — H what is happening, N does it need me, D what do
// I do, and the next CLI verb where one applies. Pure, so the copy is unit-tested.
//
// FG-838: a header carries live facts only. Object pages state theirs in one line under
// the title; a list view's contract never changes with state, so it lives in the info tip
// (info-tip.js) beside the title, and only a live count (the run index's) sits under it.
//
// Object-page copy is read off the payload on screen: the task's status and failure kind,
// and the attention inbox's own `reason` / `requestedAction` for that run or task (the
// server's derivation — for a failed task, `requestedAction` IS the retry policy's advice).
// Nothing here counts anything the server did not.

const STATUS_WORDS = {
  awaiting_gate: "awaiting a gate",
  awaiting_red: "awaiting red review",
  blocked_by_red: "blocked by a red review",
  awaiting_recovery: "awaiting recovery",
};

function statusWords(status) {
  if (typeof status !== "string" || status === "") return "in an unknown state";
  return STATUS_WORDS[status] ?? status.replace(/_/g, " ");
}

function inboxItems(load) {
  const items = load && load.phase === "ready" && load.envelope && Array.isArray(load.envelope.items) ? load.envelope.items : [];
  return items.filter((item) => item && typeof item === "object");
}

/** The open attention item naming this task, else null. */
export function attentionForTask(load, taskId) {
  return inboxItems(load).find((item) => item.links && item.links.taskId === taskId) ?? null;
}

/** The first open attention item on this run (the inbox orders them), else null. */
export function attentionForRun(load, runId) {
  return inboxItems(load).find((item) => !item.links || !item.links.runId || item.links.runId === runId) ?? null;
}

const NOTHING = "Nothing needs you";

// An inbox item's requestedAction is either advice prose or a bare CLI command. A command
// IS the verb; prose is the "what do I do" with `fallbackVerb` named after it.
function itemAction(item, fallbackTodo, fallbackVerb) {
  const action = typeof item.requestedAction === "string" && item.requestedAction !== "" ? item.requestedAction : null;
  if (action && /^forge\s/.test(action)) return { todo: "Run", verb: action };
  return { todo: action ?? fallbackTodo, verb: fallbackVerb };
}

/** Header for the task page (and, with `explain`, its Explain page). */
export function taskHeader(detail, load, { explain = false } = {}) {
  const task = detail && detail.task ? detail.task : null;
  if (!task) return { happening: "Loading the task", needsYou: false, needs: "", todo: "", verb: null };
  const id = task.taskId;
  const item = attentionForTask(load, id);
  const happening = explain
    ? `Why ${task.agentRole} ran the way it did (${statusWords(task.status)})`
    : `${task.agentRole} is ${statusWords(task.status)}`;
  if (task.status === "awaiting_gate") {
    return { happening, needsYou: true, needs: item?.reason ? `Needs you: ${item.reason}` : "Needs you: a gate decision", todo: "Decide the gate", verb: `forge gate ${id}` };
  }
  if (task.status === "failed") {
    const kind = detail.failureKind ? ` (${detail.failureKind})` : "";
    return {
      happening: `${happening}${kind}`,
      needsYou: true,
      needs: item?.reason ? `Needs you: ${item.reason}` : "Needs you: it failed",
      todo: item?.requestedAction ?? "Inspect the failure",
      verb: `forge show ${id}`,
    };
  }
  if (item) {
    return { happening, needsYou: true, needs: `Needs you: ${item.reason}`, ...itemAction(item, "Inspect it", `forge show ${id}`) };
  }
  if (task.status === "running" || task.status === "pending" || task.status === "awaiting_red") {
    return { happening, needsYou: false, needs: NOTHING, todo: "Wait for it to finish", verb: null };
  }
  return { happening, needsYou: false, needs: NOTHING, todo: "Nothing to do", verb: explain ? `forge explain ${id}` : null };
}

/** Header for the run page, from the run map's run header and the run's inbox items. */
export function runHeader(graph, load) {
  const run = graph && graph.run ? graph.run : null;
  if (!run) return { happening: "Loading the run", needsYou: false, needs: "", todo: "", verb: null };
  const happening = `Run ${statusWords(run.status)}`;
  const item = attentionForRun(load, run.runId);
  if (item) {
    const taskId = item.links && typeof item.links.taskId === "string" ? item.links.taskId : null;
    return { happening, needsYou: true, needs: `Needs you: ${item.reason}`, ...itemAction(item, "Open the task named", taskId ? `forge show ${taskId}` : "forge status") };
  }
  if (run.status === "active") return { happening, needsYou: false, needs: NOTHING, todo: "Wait, or open a task", verb: null };
  if (run.status === "failed") return { happening, needsYou: false, needs: NOTHING, todo: "Open the failed task for its advice", verb: `forge runs query --status failed` };
  return { happening, needsYou: false, needs: NOTHING, todo: "Nothing to do", verb: null };
}

/** Header for the ticket page. */
export function ticketHeader(ticketId, ticket, runsLoad) {
  const runs = runsLoad && Array.isArray(runsLoad.runs) ? runsLoad.runs : null;
  const state = ticket ? `${ticketId} is ${ticket.status}` : `Ticket ${ticketId}`;
  const happening = runs !== null && runs.length === 0 ? `${state}; no run has been dispatched for it` : state;
  if (ticket && ticket.status === "active" && runs !== null && runs.length === 0) {
    return { happening, needsYou: false, needs: NOTHING, todo: "Queue it to run", verb: `forge queue enqueue ${ticketId}` };
  }
  return { happening, needsYou: false, needs: NOTHING, todo: "", verb: `forge backlog show ${ticketId}` };
}

/** Header for one checkout's session-handoff note (FG-830). Read-only: the verb is the
 *  CLI read, run in that checkout. */
export function noteHeader(row) {
  if (!row) return { happening: "No note for this checkout", needsYou: false, needs: NOTHING, todo: "Pick a checkout from Notes", verb: "forge backlog notes show" };
  return { happening: `The handoff ${row.label} left for the next session`, needsYou: false, needs: NOTHING, todo: "", verb: "forge backlog notes show" };
}

/** Header for a review opened by id. `nextAction` is review-ledger-render's
 *  nextRequiredAction(review), passed in so this module stays dependency-free. */
export function reviewHeader(review, nextAction) {
  if (!review) return { happening: "Loading the review", needsYou: false, needs: "", todo: "", verb: null };
  const open = review.state !== "settled";
  return {
    happening: `Review ${review.id} is ${statusWords(review.state)}`,
    needsYou: open,
    needs: open ? "Needs you until it settles" : NOTHING,
    todo: nextAction || "Nothing to do",
    verb: open ? "forge review show " + review.id : null,
  };
}

/** The run index's live line, from GET /api/runs's server-computed activeCount; empty
 *  until that count is read. Its contract is in the tip (LIST_HEADERS.runs). */
export function runsIndexHeader(load) {
  const active = load && load.phase === "ready" && Number.isInteger(load.body?.activeCount) ? load.body.activeCount : null;
  const happening = active === null ? "" : active === 0 ? "No run is active" : `${active} ${active === 1 ? "run is" : "runs are"} active`;
  return { happening, needsYou: false, needs: "", todo: "", verb: null };
}

// The list views' contracts: the plan's "What it answers" column. Shown in the info tip.
const LIST_HEADERS = {
  runs: { happening: "What ran and what is running", needs: "Needs you only via Home", todo: "Open a run to walk its tasks", verb: "forge runs query" },
  home: { happening: "What needs you, then what is running", needs: "The Needs you list is exactly what needs you", todo: "Act on each item's command", verb: "forge attention list" },
  activity: { happening: "What finished and what is running", needs: "Home owns what needs you", todo: "Open an output to read it", verb: "forge status" },
  backlog: { happening: "What is filed, in what state", needs: "Readiness gaps count on Home", todo: "Open a ticket for its runs", verb: "forge backlog list" },
  notes: { happening: "Where each checkout's last session left off", needs: NOTHING, todo: "Open a checkout's note to read it", verb: "forge backlog notes show" },
  queue: { happening: "What runs next", needs: "Only if you are planning", todo: "Rank, enqueue or dequeue", verb: "forge queue" },
  campaigns: { happening: "Campaign progress and pauses", needs: "Pauses count on Home", todo: "Open a campaign for its items", verb: "forge campaign show" },
  reviews: { happening: "Review outcomes and open findings", needs: "Open fix_now findings count on Home", todo: "Record a disposition", verb: "forge review disposition" },
  shipping: { happening: "Whether each ticket can ship", needs: "Only when you are shipping", todo: "Read a ticket's readiness", verb: "forge readiness" },
  roles: { happening: "What each role is and runs on", needs: "A seed changes only through forge upgrade", todo: "Open a role for its instructions and receipts", verb: "forge model resolve <role>" },
  routing: { happening: "The effective routing policy", needs: NOTHING, todo: "Read why a role routes here", verb: "forge route governance" },
  models: { happening: "The model policy and what every role resolves to", needs: NOTHING, todo: "Propose and apply a policy change", verb: "forge model policy propose" },
  config: { happening: "The effective config and its precedence", needs: NOTHING, todo: "Read where a value came from", verb: "forge config show" },
  projects: { happening: "The project and checkout registry", needs: "Only an unclassified project", todo: "Classify or pick a scope", verb: "forge projects classify" },
  usage: { happening: "Spend, model mix and plan pace", needs: NOTHING, todo: "Watch the pace", verb: "forge usage" },
  ops: { happening: "Success rate, failure mix and durations", needs: NOTHING, todo: "Hunt regressions", verb: "forge ops check" },
};

/** A list view's contract, for its info tip; null for a view without one. */
export function listHeader(view) {
  const line = LIST_HEADERS[view];
  return line ? { ...line, needsYou: false } : null;
}

export const LIST_HEADER_VIEWS = Object.keys(LIST_HEADERS);

/** What a list view renders under its title: a live line, or null. Only the run index
 *  has one. */
export function listScreenLine(view, runsLoad) {
  if (view !== "runs") return null;
  const header = runsIndexHeader(runsLoad);
  return header.happening === "" ? null : header;
}

/** The one short line, as plain text (the view renders `verb` as code). */
export function screenLineText(header) {
  if (!header) return "";
  const parts = [header.happening, header.needs, header.todo].filter((s) => typeof s === "string" && s !== "");
  const text = parts.join(" · ");
  return header.verb ? `${text}: ${header.verb}` : text;
}

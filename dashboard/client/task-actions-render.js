// FG-822: the task actions, as data. GET /api/task/:id/actions decides which actions a task
// admits (the server's preview — the retry policy and the re-drive guard never run here);
// this module only validates that payload, builds the POST a confirmed action sends, and
// reads the verb's own result back. Pure, so it is unit-tested without a DOM.

export const ACTIONS_UNAVAILABLE = "Task actions unavailable";

function isEligible(e) {
  return e && typeof e === "object" && typeof e.action === "string" && typeof e.verb === "string" &&
    typeof e.route === "string" && Array.isArray(e.argv) && typeof e.reason === "string";
}

function isRefused(r) {
  return r && typeof r === "object" && typeof r.action === "string" && typeof r.verb === "string" && typeof r.reason === "string";
}

/** A preview response → the load the view renders. A malformed payload is unavailable,
 *  never "no actions": the absence of a button must mean the server refused it. */
export function actionsFromResponse(status, body) {
  if (status !== 200 || !body || typeof body !== "object") {
    const detail = body && typeof body.error === "string" ? body.error : `HTTP ${status}`;
    return { phase: "unavailable", detail };
  }
  if (!Array.isArray(body.eligible) || !Array.isArray(body.refused) || !body.eligible.every(isEligible) || !body.refused.every(isRefused)) {
    return { phase: "unavailable", detail: "the preview payload is malformed" };
  }
  const mutations = body.mutations && typeof body.mutations === "object" ? body.mutations : { available: false, reason: null };
  return {
    phase: "ready",
    eligible: body.eligible,
    refused: body.refused.map((r) => ({ ...r, advice: typeof r.advice === "string" && r.advice !== "" ? r.advice : null })),
    available: mutations.available === true,
    unavailableReason: typeof mutations.reason === "string" ? mutations.reason : null,
  };
}

export function actionKey(e) {
  return e.decision ? `${e.action}:${e.decision}` : e.action;
}

/** The buttons to show: eligible actions, and only when this bind admits mutations. */
export function actionButtons(load) {
  if (!load || load.phase !== "ready" || !load.available) return [];
  return load.eligible.map((e) => ({ key: actionKey(e), label: e.verb, action: e.action, decision: e.decision ?? null }));
}

/** The command as it will run, shown before the operator confirms. */
export function previewCommand(e, rationale = "") {
  if (!e.requiresRationale) return e.verb;
  const text = rationale.trim() === "" ? "<rationale>" : rationale.replace(/\s+/g, " ").trim();
  return `${e.verb} --rationale ${JSON.stringify(text)}`;
}

/** The request a confirmed action sends, or the reason it cannot be sent yet. */
export function confirmRequest(e, rationale = "") {
  if (e.requiresRationale) {
    if (typeof rationale !== "string" || rationale.trim() === "") {
      return { ok: false, error: "A rationale is required for every gate decision." };
    }
    return { ok: true, route: e.route, body: { decision: e.decision, rationale } };
  }
  return { ok: true, route: e.route, body: {} };
}

/** The verb's own result, as the inline line and output block. */
export function actionResult(status, body, verb) {
  const b = body && typeof body === "object" ? body : {};
  const exitCode = Number.isInteger(b.exitCode) ? b.exitCode : null;
  const output = [b.stdout, b.stderr].filter((s) => typeof s === "string" && s.trim() !== "").join("\n");
  const ok = status === 200 && b.ok === true;
  const name = typeof b.verb === "string" ? b.verb : verb;
  const line = exitCode !== null
    ? `${name} exited ${exitCode}`
    : `${name} was refused (HTTP ${status})`;
  const detail = !ok && typeof b.error === "string" && b.error !== "" && b.error !== output ? b.error : null;
  return { ok, line, output, detail };
}

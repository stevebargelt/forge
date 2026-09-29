// FG-823: Dismiss / Snooze / Undismiss on an Attention inbox row, as data. The dismissal
// itself lives server-side (the CLI writes attention_dismissals and its event); this module
// only builds the POST a confirmed choice sends, previews the command it runs, and reads
// the verb's result back. It stores nothing — no read or dismiss state, no localStorage.
// Pure, so it is unit-tested without a DOM.

/** The preset snooze lengths, as the CLI's own `--until` grammar. */
export const SNOOZE_PRESETS = ["1h", "4h", "1d"];

export const ATTENTION_ACTIONS = ["dismiss", "snooze", "undismiss"];

export function attentionRoute(itemId, action) {
  return `/api/attention/${encodeURIComponent(itemId)}/${action}`;
}

/** The command as it will run, shown before the operator confirms. */
export function attentionCommand(itemId, action, until = null) {
  const base = `forge attention ${action} ${itemId}`;
  if (action !== "snooze") return base;
  return `${base} --until ${until && until.trim() !== "" ? until.trim() : "<until>"}`;
}

/** The request a confirmed choice sends, or why it cannot be sent yet. A custom snooze
 *  instant is checked only for shape here; the server and the CLI decide the rest. */
export function attentionRequest(itemId, action, { until = null, rationale = "" } = {}) {
  const body = {};
  if (action === "snooze") {
    const value = typeof until === "string" ? until.trim() : "";
    if (value === "") return { ok: false, error: "Choose how long to snooze, or enter an ISO time." };
    if (!SNOOZE_PRESETS.includes(value) && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
      return { ok: false, error: "A custom snooze must be an ISO time, e.g. 2026-10-01T09:00:00Z." };
    }
    body.until = value;
  }
  if (action !== "undismiss" && typeof rationale === "string" && rationale.trim() !== "") body.rationale = rationale;
  return { ok: true, route: attentionRoute(itemId, action), body };
}

/** The verb's own result, as the inline line and detail. */
export function attentionResult(status, body, command) {
  const b = body && typeof body === "object" ? body : {};
  const ok = status === 200 && b.ok === true;
  const exitCode = Number.isInteger(b.exitCode) ? b.exitCode : null;
  const line = exitCode !== null ? `${command} exited ${exitCode}` : `${command} was refused (HTTP ${status})`;
  const detail = !ok ? (typeof b.error === "string" && b.error !== "" ? b.error : null) : typeof b.stdout === "string" && b.stdout !== "" ? b.stdout : null;
  return { ok, line, detail };
}

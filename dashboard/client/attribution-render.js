// FG-845: the pure half of the git-attribution surfaces — the Config row, the controls
// card and the Projects card line all read the API's `aiAttribution` object
// (describeAiAttribution, src/v2/ai-attribution.ts) through these helpers.

export const PROJECT_CHOICES = Object.freeze([
  { value: "suppress", label: "suppress" },
  { value: "allow", label: "allow" },
  { value: "inherit", label: "inherit host default" },
]);

export const HOST_CHOICES = Object.freeze([
  { value: "suppress", label: "suppress" },
  { value: "allow", label: "allow" },
]);

/** The source tag: a fail-closed stop outranks the level it stopped at. */
export function attributionTag(view) {
  if (view.reason) return { key: "fail_closed", label: "fail-closed" };
  if (view.source === "project") return { key: "project", label: "project override" };
  if (view.source === "host") return { key: "host", label: "host default" };
  return { key: "default", label: "built-in default" };
}

/** The exact verb a control choice runs, as the operator would type it. */
export function attributionCommand(target, choice) {
  if (target === "host") return `forge config set ai-attribution ${choice} --host`;
  if (choice === "inherit") return "forge config unset ai-attribution";
  return `forge config set ai-attribution ${choice}`;
}

/** The file a control choice changes. */
export function attributionTargetFile(target, view) {
  return target === "host" ? view.hostFile : `${view.checkout}/.forge/config.yml`;
}

/** The project control's current value; null when the project file fails closed. */
export function currentProjectChoice(view) {
  if (view.inheritsHost) return "inherit";
  return view.source === "project" ? view.mode : null;
}

/** The host control's current value; null when no host default is set. */
export function currentHostChoice(view) {
  return view.host ? view.host.mode : null;
}

/** How many Projects cards inherit the host default, of those with an attribution read. */
export function inheritCount(projects) {
  const read = (projects ?? []).filter((p) => p && p.aiAttribution);
  return { inherit: read.filter((p) => p.aiAttribution.inheritsHost).length, total: read.length };
}

/** A Confirm's inline outcome: applied, refused (the server's reason, which already names
 *  the file state), or a transport failure — the request never got an answer, so whether
 *  the verb ran is unknown. Never rejects, so the control always leaves its running state. */
export async function confirmOutcome(post, command) {
  let response;
  try {
    response = await post();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: "transport",
      text: `the dashboard could not reach the server (${why}); whether ${command} ran is unknown — re-check the value once it is reachable.`,
    };
  }
  const { status, body } = response;
  if (body?.ok) return { ok: true, kind: "applied", text: body.stdout || `${command} done` };
  return { ok: false, kind: "refused", text: body?.error || `HTTP ${status}` };
}

/** The roving-tabindex move for a segmented group: the next value for an arrow key, else null. */
export function segmentStep(values, current, key) {
  const i = Math.max(0, values.indexOf(current));
  if (key === "ArrowRight" || key === "ArrowDown") return values[(i + 1) % values.length];
  if (key === "ArrowLeft" || key === "ArrowUp") return values[(i - 1 + values.length) % values.length];
  if (key === "Home") return values[0];
  if (key === "End") return values[values.length - 1];
  return null;
}

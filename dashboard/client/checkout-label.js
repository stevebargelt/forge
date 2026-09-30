// FG-831: THE checkout label rule, exported once. Every surface that names a checkout —
// the scope bar, the Projects card, Notes rows, ticket chips, Activity — calls this
// module rather than re-deriving a name from `branch` or a basename, which is how the
// scope bar came to read "main" fifteen times.
//
// THE RULE: the checkout directory's basename, plus as many parent segments as it takes
// to be unique among the project's checkouts, then ` · <branch>` when git reported one.
// A checkout whose directory is gone reads ` · missing on disk` instead of a branch
// (git cannot report the branch of a directory that is not there).
//
// Checkout paths arrive already canonical: the registry resolves every checkout root
// that exists through realpath (FG-693), so an alias and its target are one checkout by
// the time they reach the browser. `dedupeCheckouts` collapses what is left — a
// trailing-separator spelling, a registry that listed a root twice — by exact path; it
// cannot and does not claim two unproven (missing) spellings name one directory.

export const MISSING_LABEL = "missing on disk";
export const PRUNE_VERB = "forge projects prune --missing";

function segmentsOf(dir) {
  return String(dir).replace(/\/+$/, "").split("/").filter((s) => s !== "");
}

function pathKey(dir) {
  return String(dir).replace(/\/+$/, "") || "/";
}

function suffix(segments, n) {
  return segments.slice(-n).join("/");
}

/** One entry per canonical checkout path, first occurrence wins, order kept. */
export function dedupeCheckouts(checkouts) {
  const seen = new Set();
  const out = [];
  for (const checkout of Array.isArray(checkouts) ? checkouts : []) {
    if (!checkout || typeof checkout.projectDir !== "string") continue;
    const key = pathKey(checkout.projectDir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(checkout);
  }
  return out;
}

/** The shortest trailing path of `checkout.projectDir` that no other checkout in `all`
 *  shares — its basename when that is already unique. */
export function checkoutPathLabel(checkout, all) {
  const own = segmentsOf(checkout.projectDir);
  if (own.length === 0) return "/";
  const others = dedupeCheckouts(all)
    .filter((c) => pathKey(c.projectDir) !== pathKey(checkout.projectDir))
    .map((c) => segmentsOf(c.projectDir));
  for (let n = 1; n <= own.length; n += 1) {
    const mine = suffix(own, n);
    if (!others.some((segments) => suffix(segments, n) === mine)) return mine;
  }
  return pathKey(checkout.projectDir);
}

/** The label for one checkout among its project's checkouts: `<path> · <branch>`, or
 *  `<path> · missing on disk`. */
export function checkoutLabel(checkout, all) {
  const path = checkoutPathLabel(checkout, all);
  if (checkout.exists === false) return `${path} · ${MISSING_LABEL}`;
  return checkout.branch ? `${path} · ${checkout.branch}` : path;
}

/** The registered checkout a directory belongs to — a checkout root, or any exact run
 *  directory the registry observed under one (`projectDirs`) — with its project; null
 *  when no project knows it. The registry grouped every recorded spelling by its
 *  path-identity (FG-693) before serving it, so a run recorded through a symlinked parent
 *  is listed under the physical checkout it names; this matches against that result and
 *  never re-derives identity in the browser. */
export function checkoutForDir(dir, projects) {
  if (typeof dir !== "string" || dir === "") return null;
  const key = pathKey(dir);
  for (const project of Array.isArray(projects) ? projects : []) {
    const checkouts = Array.isArray(project?.checkouts) ? project.checkouts : [];
    const checkout = checkouts.find((c) => c && typeof c.projectDir === "string" && (
      pathKey(c.projectDir) === key || (Array.isArray(c.projectDirs) && c.projectDirs.some((d) => pathKey(d) === key))
    ));
    if (checkout) return { project, checkout };
  }
  return null;
}

/** The same label for a bare directory, resolved against the registry's projects. An
 *  unregistered directory falls back to its basename (plus the branch when known). */
export function checkoutLabelForDir(dir, projects, branch = null) {
  if (typeof dir !== "string" || dir === "") return "";
  const match = checkoutForDir(dir, projects);
  if (match) return checkoutLabel(match.checkout, match.project.checkouts);
  const base = segmentsOf(dir).pop() || dir;
  return branch ? `${base} · ${branch}` : base;
}

/**
 * The scope bar's checkout options for one project, as data.
 *
 * Deduplicated by canonical path; the primary checkout first and flagged, then the
 * on-disk checkouts, then the missing ones. A checkout whose directory is gone is
 * withheld unless `showMissing`, and always counted in `missingCount`. A missing checkout that is the CURRENT selection is always offered, so
 * a pasted or remembered scope still reads as selected rather than vanishing.
 */
export function checkoutOptions(project, { showMissing = false, selected = null } = {}) {
  const all = dedupeCheckouts(project?.checkouts);
  const primaryKey = project?.primaryCheckout ? pathKey(project.primaryCheckout) : null;
  const isPrimary = (c) => pathKey(c.projectDir) === primaryKey;
  const ordered = [
    ...all.filter(isPrimary),
    ...all.filter((c) => !isPrimary(c) && c.exists !== false),
    ...all.filter((c) => !isPrimary(c) && c.exists === false),
  ];
  const selectedKey = selected ? pathKey(selected) : null;
  const missingCount = ordered.filter((c) => c.exists === false).length;
  const options = ordered
    .filter((c) => c.exists !== false || showMissing || pathKey(c.projectDir) === selectedKey)
    .map((c) => ({
      projectDir: c.projectDir,
      label: checkoutLabel(c, all),
      primary: isPrimary(c),
      missing: c.exists === false,
    }));
  return { options, missingCount };
}

// FG-843: the checkout chooser on Routing, Config and Notes — the only views whose answer
// changes with the checkout. It offers the project's LIVE OPERATOR checkouts (the server's
// `kind`, derived once in dashboard/src/queries.ts; never re-derived here), primary first
// and flagged. With fewer than two it is not a chooser at all: the header shows the label
// as plain text. A run checkout named by the hash (a deep link from a run page) is honoured
// and reads `run checkout`; the menu then offers the operator checkouts to go back to.

export const RUN_CHECKOUT_LABEL = "run checkout";

/** `operator` or `run` for a directory of this project (a checkout root or an exact run
 *  directory observed under one); null when the project does not know the directory. */
export function checkoutKindForDir(dir, project) {
  const match = project ? checkoutForDir(dir, [project]) : null;
  if (!match) return null;
  return match.checkout.kind === "operator" ? "operator" : "run";
}

/** The checkout a hash's `checkout=` names when the project knows it (an operator or a
 *  run checkout), else null: an unknown path is not a run checkout, it is unknown, and a
 *  checkout-scoped view falls back to the primary (the FG-828 pattern for unknown values). */
export function knownCheckout(dir, project) {
  return checkoutKindForDir(dir, project) === null ? null : dir;
}

/** A home-relative spelling of a directory for the menu's secondary column. */
export function displayPath(dir) {
  return String(dir).replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** The checkout a checkout-scoped view reads when the hash names none: the primary. */
export function defaultCheckout(project) {
  return typeof project?.primaryCheckout === "string" && project.primaryCheckout !== "" ? project.primaryCheckout : null;
}

/** The checkout a view's OWN read is scoped to: Routing and Config read one checkout's
 *  files, so they get the hash's known checkout, else the primary; every other view gets
 *  null and reads the whole project. Before the project has loaded, the hash's checkout
 *  stands. Shared reads (activity, in-flight, inbox, badges) never take this value. */
export function viewCheckout(view, projectKey, project, requested) {
  if (!projectKey || (view !== "routing" && view !== "config")) return null;
  if (!project) return requested ?? null;
  return knownCheckout(requested, project) ?? defaultCheckout(project);
}

/**
 * The chooser as data for one project and the checkout on screen (null = the primary).
 *
 *   mode     "none" (no project), "label" (plain text) or "menu" (button + listbox)
 *   current  { projectDir, label, primary, run } — `run` when the hash named a run checkout
 *   options  the live operator checkouts, primary first: { projectDir, label, primary, path, selected }
 *   footer   `N operator checkouts · M run checkouts are listed on their runs, not here`
 */
export function checkoutChooser(project, selected = null) {
  const all = dedupeCheckouts(project?.checkouts);
  const currentDir = knownCheckout(selected, project) || defaultCheckout(project);
  if (!project || !currentDir) return { mode: "none", current: null, options: [], footer: "" };
  const primaryKey = pathKey(project.primaryCheckout ?? "");
  const currentKey = pathKey(currentDir);
  const live = all.filter((c) => c.kind === "operator" && c.exists !== false);
  const ordered = [...live.filter((c) => pathKey(c.projectDir) === primaryKey), ...live.filter((c) => pathKey(c.projectDir) !== primaryKey)];
  const options = ordered.map((c) => ({
    projectDir: c.projectDir,
    label: checkoutLabel(c, all),
    primary: pathKey(c.projectDir) === primaryKey,
    path: displayPath(c.projectDir),
    selected: pathKey(c.projectDir) === currentKey,
  }));
  const run = checkoutKindForDir(currentDir, project) === "run";
  const current = {
    projectDir: currentDir,
    label: checkoutLabelForDir(currentDir, [project]),
    primary: currentKey === primaryKey,
    run,
  };
  const runCount = Number.isInteger(project.checkoutCounts?.run) ? project.checkoutCounts.run : all.filter((c) => c.kind !== "operator").length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const footer = `${plural(options.length, "operator checkout")} · ${plural(runCount, "run checkout")} ${runCount === 1 ? "is" : "are"} listed on ${runCount === 1 ? "its run" : "their runs"}, not here`;
  const mode = options.length >= 2 || (run && options.length >= 1) ? "menu" : "label";
  return { mode, current, options, footer };
}

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

/** The same label for a bare directory — a checkout root or any exact run directory the
 *  registry observed under one — resolved against the registry's projects. An
 *  unregistered directory falls back to its basename (plus the branch when known). */
export function checkoutLabelForDir(dir, projects, branch = null) {
  if (typeof dir !== "string" || dir === "") return "";
  const key = pathKey(dir);
  for (const project of Array.isArray(projects) ? projects : []) {
    const checkouts = Array.isArray(project?.checkouts) ? project.checkouts : [];
    const match = checkouts.find((c) => c && typeof c.projectDir === "string" && (
      pathKey(c.projectDir) === key || (Array.isArray(c.projectDirs) && c.projectDirs.some((d) => pathKey(d) === key))
    ));
    if (match) return checkoutLabel(match, checkouts);
  }
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

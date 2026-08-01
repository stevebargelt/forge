// FG-654: the Forge-owned agent protocol region — ownership split INSIDE an
// operator-authored seed file.
//
// FG-578 made ~/.forge/agents/<role>/CLAUDE.md operator-authored: forge creates it
// once and never writes over it, FORCE=1 included. That is right for the operator's
// own customization and wrong for the REVIEW PROTOCOL, which is Forge's — the two
// shared one overwrite-or-retain unit, so protecting the second silently froze the
// first. Measured 2026-07-31: every discovery lens on the reporting host was running
// a pre-evidence-led contract, which surfaced downstream as a malformed_output storm
// rather than as a seed problem, and nothing in the run record said which protocol
// generation had actually run.
//
// So: one marker-fenced region per covered seed. Everything OUTSIDE it stays the
// operator's under exactly the FG-578 rules; the region inside is published
// deterministically by `forge upgrade`. The mechanism is ORTHOGONAL to
// install-seeds.sh's AUTHORED_EXEMPT categories, which are untouched — there is
// exactly ONE publisher of this region and it is this module.
//
// IDENTITY IS THE REGION, not the file and not the composed prompt. A whole-file
// hash would make every customizing host permanently stale; a composed-prompt hash
// varies with step id / workflow / runTags / the constraint filter, so it is unique
// per task and answers nothing. REQUIRED is read from the executing release,
// INSTALLED from $FORGE_HOME — two independent reads, never one restating the other.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assetRoot } from "./asset-root.js";
import { RISK_LENSES, lensRole } from "./review-contract.js";

// HTML comments, mirroring the orchestrator block's markers (init.ts) so they render
// invisibly in the seed an operator reads.
export const PROTOCOL_START_MARKER = "<!-- forge:agent-protocol-start -->";
export const PROTOCOL_END_MARKER = "<!-- forge:agent-protocol-end -->";

/** The suffix `publishAgentProtocolRegions` gives the pre-adoption copy of a seed
 *  whose legacy Forge sections were not byte-identical to this release's. */
export const PRE_ADOPTION_BACKUP_SUFFIX = ".forge-pre-fg654.bak";

/** The failure kind a refused dispatch carries, and the discovery vocabulary word for
 *  the same fact. One literal so the dispatch seam and the ledger cannot drift. */
export const STALE_PROTOCOL_FAILURE_KIND = "stale_protocol";

/** The four review-lifecycle dispatch roles that are NOT one of the five risk lenses.
 *  They cannot be derived from a type, so `fg578-ownership-agreement.test.ts` parses the
 *  real dispatch sites (review-wiring.ts's `agentRole:` literals, runNext.ts's
 *  shipping-reviewer literal) and fails naming any role missing from here. */
export const NON_LENS_COVERED_ROLES = [
  "engineer",
  "documentation-maintainer",
  "review-rechecker",
  "shipping-reviewer",
] as const;

/** Every role the review lifecycle dispatches. The lens half is DERIVED from
 *  review-contract's own map — a hand-copied lens list is the same defect class as a
 *  seed that drifts silently. */
export const COVERED_ROLES: readonly string[] = [
  ...RISK_LENSES.map((l) => lensRole(l)),
  ...NON_LENS_COVERED_ROLES,
];

export function isCoveredRole(role: string): boolean {
  return COVERED_ROLES.includes(role);
}

function forgeHomeDefault(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}

export function installedSeedPath(role: string, forgeHome: string = forgeHomeDefault()): string {
  return join(forgeHome, "agents", role, "CLAUDE.md");
}

export function releaseSeedsDirDefault(): string {
  return join(assetRoot(), "seeds");
}

export function releaseSeedPath(role: string, seedsDir: string = releaseSeedsDirDefault()): string {
  return join(seedsDir, "agents", role, "CLAUDE.md");
}

// ─── the region itself ──────────────────────────────────────────────────────

/** LF-normalized and trimmed. The unit of identity, so a CRLF checkout and a trailing
 *  blank line are not protocol changes. */
export function normalizeRegion(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function protocolSha256(region: string): string {
  return createHash("sha256").update(normalizeRegion(region), "utf8").digest("hex");
}

export type RegionRead =
  | { kind: "fenced"; region: string }
  | { kind: "unfenced" }
  | { kind: "unbalanced"; detail: string };

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Read the fenced region out of a seed's text. A lone marker or a duplicated pair is
 *  `unbalanced` — an ambiguous boundary this module refuses to guess at rather than
 *  risk swallowing the operator's tail. */
export function readProtocolRegion(text: string): RegionRead {
  const starts = countOccurrences(text, PROTOCOL_START_MARKER);
  const ends = countOccurrences(text, PROTOCOL_END_MARKER);
  if (starts === 0 && ends === 0) return { kind: "unfenced" };
  if (starts !== 1 || ends !== 1) {
    return { kind: "unbalanced", detail: `${starts} start marker(s) and ${ends} end marker(s)` };
  }
  const s = text.indexOf(PROTOCOL_START_MARKER);
  const e = text.indexOf(PROTOCOL_END_MARKER);
  if (e < s) return { kind: "unbalanced", detail: "the end marker precedes the start marker" };
  return { kind: "fenced", region: normalizeRegion(text.slice(s + PROTOCOL_START_MARKER.length, e)) };
}

export function fencedBlock(region: string): string {
  return `${PROTOCOL_START_MARKER}\n\n${normalizeRegion(region)}\n\n${PROTOCOL_END_MARKER}`;
}

// ─── the adoption ladder (D10) ──────────────────────────────────────────────

export type ProtocolApplyResult =
  | {
      action: "replaced" | "adopted" | "appended" | "unchanged";
      content: string;
      /** true when an excised legacy section differed from this release's — the caller
       *  writes the pre-adoption backup and names it. */
      excisedChanged: boolean;
    }
  | { action: "needs-markers"; content: string; message: string };

type Heading = { index: number; line: string; depth: number };

/** Headings at fence depth 0, at EVERY markdown depth. A `## ` inside a fenced code
 *  block is content, not a boundary — mis-reading one is how a splice swallows an
 *  operator's section. Depth matters twice over: `# `/`## ` bound a section's extent,
 *  and `### ` and deeper decide which lines INSIDE a matched section are Forge's. */
function headingLines(text: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6}) /.exec(line);
    if (m) out.push({ index: i, line: line.trimEnd(), depth: (m[1] as string).length });
  }
  return out;
}

/** The `## ` headings this release's region owns. Operator sections have different
 *  headings and therefore cannot be excised by adoption. */
export function regionHeadings(region: string): string[] {
  return headingLines(normalizeRegion(region))
    .filter((h) => h.depth === 2)
    .map((h) => h.line);
}

/** EVERY heading the release's region carries, at every depth. A `## ` match says a
 *  section is Forge's; this says which lines inside it are. An operator's own `### `
 *  nested under a Forge `## ` is not in here, and adoption keeps it. */
function regionOwnedHeadings(region: string): Set<string> {
  return new Set(headingLines(normalizeRegion(region)).map((h) => h.line));
}

/** The Forge-owned line ranges inside one matched `## ` section [from, to).
 *
 *  The heading matched, so the section is Forge's — but a `### ` inside it whose heading
 *  the release region does NOT carry is the operator's, nested under a Forge heading (the
 *  shape 6 of the 9 release seeds invite by using `### ` subsections themselves). Those
 *  runs are left out of the excision, so they stay in the LIVE seed rather than surviving
 *  only in the .bak. A run ends at the next sub-heading the region does own.
 *
 *  Where such a run lands is decided by the caller, and it is not free: the region is ONE
 *  contiguous fenced block, so a run that sat BETWEEN two Forge runs cannot stay between
 *  them. See the placement note at `insertAt`. */
function forgeRangesIn(
  from: number,
  to: number,
  headings: readonly Heading[],
  owned: ReadonlySet<string>,
): Array<{ from: number; to: number }> {
  const subs = headings.filter((h) => h.depth >= 3 && h.index > from && h.index < to);
  const out: Array<{ from: number; to: number }> = [];
  let cursor = from;
  let i = 0;
  while (i < subs.length) {
    const s = subs[i] as Heading;
    if (s.index < cursor || owned.has(s.line)) {
      i += 1;
      continue;
    }
    if (s.index > cursor) out.push({ from: cursor, to: s.index });
    let j = i + 1;
    while (j < subs.length && !owned.has((subs[j] as Heading).line)) j += 1;
    cursor = j < subs.length ? (subs[j] as Heading).index : to;
    i = j;
  }
  if (cursor < to) out.push({ from: cursor, to });
  return out;
}

/** Adopt an unmarked legacy seed, or splice a fenced one. Pure over its inputs;
 *  everything outside the region survives verbatim and in order. */
export function applyProtocolRegion(existing: string, releaseRegion: string): ProtocolApplyResult {
  const block = fencedBlock(releaseRegion);
  const read = readProtocolRegion(existing);

  if (read.kind === "unbalanced") {
    return {
      action: "needs-markers",
      content: existing,
      message:
        `${read.detail} — forge cannot tell where the Forge-owned protocol region begins and ends, and will not ` +
        `guess at a boundary that could swallow your own sections. Repair by hand: the file must contain EXACTLY ` +
        `one '${PROTOCOL_START_MARKER}' line and EXACTLY one '${PROTOCOL_END_MARKER}' line after it, with the ` +
        `Forge review-protocol sections between them. Nothing was written.`,
    };
  }

  if (read.kind === "fenced") {
    const s = existing.indexOf(PROTOCOL_START_MARKER);
    const e = existing.indexOf(PROTOCOL_END_MARKER) + PROTOCOL_END_MARKER.length;
    const content = existing.slice(0, s) + block + existing.slice(e);
    return {
      action: content === existing ? "unchanged" : "replaced",
      content,
      // The splice DISCARDS whatever was between the markers, and those bytes are Forge's
      // only if nobody hand-wrapped their own prose inside them — which is exactly what
      // the needs-markers repair text asks an operator to do. So a region that differed is
      // a lossy path and gets the same backup adoption gets. An already-current host is
      // `unchanged` and never reaches here, so this writes no .bak on a no-op upgrade.
      excisedChanged: read.region !== normalizeRegion(releaseRegion),
    };
  }

  // No markers. Heading-anchored adoption: excise each section whose heading matches one
  // the release's region owns, and fence the region in at the FIRST excised position.
  const wanted = new Set(regionHeadings(releaseRegion));
  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  const headings = headingLines(existing);
  const matches = headings.filter((h) => wanted.has(h.line));

  const seen = new Set<string>();
  for (const m of matches) {
    if (seen.has(m.line)) {
      return {
        action: "needs-markers",
        content: existing,
        message:
          `'${m.line}' appears more than once, so forge cannot tell which occurrence is the Forge-owned ` +
          `protocol section. Repair by hand: delete the duplicate, or wrap the Forge sections in ` +
          `'${PROTOCOL_START_MARKER}' / '${PROTOCOL_END_MARKER}' yourself. Nothing was written.`,
      };
    }
    seen.add(m.line);
  }

  if (matches.length === 0) {
    // Nothing is overwritten, so nothing can be lost. This is the measured common case:
    // a legacy seed that never carried the FG-640 sections at all.
    //
    // The separator is DERIVED from what the file already ends with rather than trimmed
    // off it: trailing spaces, blank lines and a CRLF tail are operator bytes, and this
    // rung's whole claim is that it removes none. Trimming them here would make the one
    // path that writes no .bak also the path that silently edits the operator's file.
    const sep = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { action: "appended", content: `${existing}${sep}${block}\n`, excisedChanged: false };
  }

  // A PARTIAL heading match ADOPTS, and this is deliberate (RF-16). The refusal that stood
  // here assumed a legacy Forge block carries the release region's `## ` headings as a SET.
  // That does not hold ACROSS releases: red-wide's five region headings landed in five
  // separate commits between 2026-05-26 and 2026-07-30, and under FG-578 a seed is never
  // rewritten after creation — so a proper SUBSET is exactly what the ORDINARY legacy host
  // holds. Refusing it left that host unfenced, `forge upgrade` exiting 1, and every
  // dispatch of the role refused `stale_protocol` with no self-service remedy.
  //
  // The risk that refusal aimed at — an operator section that happens to share a Forge
  // heading's name — is real, unprovable in either direction, and handled the way every
  // other lossy path here is: the pre-adoption `.bak` is written and NAMED in upgrade's
  // output. A certain, universal brick is not a defensible price for a rare, recoverable
  // collision. The genuinely ambiguous shapes still refuse above: a hand-edited fence, and
  // a duplicated region heading — where forge cannot even tell which occurrence is ours.

  // Section extent: the heading line through the line before the next `# `/`## ` at fence
  // depth 0, or EOF. A `### ` does NOT end the section — it is nested content — so the
  // section's own sub-headings decide which of its lines are Forge's (below).
  const owned = regionOwnedHeadings(releaseRegion);
  const headingIdx = headings.filter((h) => h.depth <= 2).map((h) => h.index);
  const ranges: Array<{ from: number; to: number }> = [];
  for (const m of matches) {
    const next = headingIdx.find((i) => i > m.index);
    const to = next === undefined ? lines.length : next;
    ranges.push(...forgeRangesIn(m.index, to, headings, owned));
  }
  ranges.sort((a, b) => a.from - b.from);

  // PLACEMENT (RF-17). The fence takes the position of the FIRST Forge line it adopted, so
  // the operator's own top-level sections keep their positions around it and every kept
  // line keeps its order relative to every other kept line. The one thing that cannot be
  // held is the position of an operator run that sat strictly BETWEEN two Forge runs: the
  // region is a single contiguous block, so that run has to come out on one side of it. It
  // comes out immediately AFTER the closing fence — the nearest legal position, and the one
  // that still reads after the Forge prose it was written under. A run written at the END of
  // the adopted span is already there and does not move at all. Documented in
  // docs/how-to-upgrade.md rather than left for an operator to discover in a diff.
  const excised: string[] = [];
  const kept: string[] = [];
  let insertAt = -1;
  let cursor = 0;
  for (const r of ranges) {
    for (let i = cursor; i < r.from; i += 1) kept.push(lines[i] as string);
    if (insertAt < 0) insertAt = kept.length;
    excised.push(lines.slice(r.from, r.to).join("\n"));
    cursor = r.to;
  }
  for (let i = cursor; i < lines.length; i += 1) kept.push(lines[i] as string);

  const head = kept.slice(0, insertAt).join("\n").replace(/\s*$/, "");
  const tail = kept.slice(insertAt).join("\n").replace(/^\s*/, "");
  const content =
    (head.length > 0 ? `${head}\n\n` : "") + block + (tail.length > 0 ? `\n\n${tail}\n` : "\n");

  return {
    action: "adopted",
    content,
    // Each excised chunk is trimmed before joining: a section's extent includes the blank
    // line that separated it from the next heading, and that separator is not a content
    // difference. Getting this wrong writes a .bak on every already-current host.
    excisedChanged: excised.map((s) => normalizeRegion(s)).join("\n\n") !== normalizeRegion(releaseRegion),
  };
}

// ─── required vs installed (D6) ─────────────────────────────────────────────

/** The RECORDED dispatch-time protocol fact. Written into the task manifest and
 *  indexed by the review ledger. */
export type AgentProtocolStamp = {
  role: string;
  sha256: string;
  /** the installed seed the dispatched agent actually read */
  source: string;
};

export type ProtocolResolution =
  | {
      ok: true;
      role: string;
      sha256: string;
      requiredSha256: string;
      installedPath: string;
      releasePath: string;
    }
  | {
      ok: false;
      role: string;
      reason:
        | "release_missing"
        | "release_unfenced"
        | "installed_missing"
        | "installed_unfenced"
        | "installed_unbalanced"
        | "stale";
      refusal: string;
      installedPath: string;
      releasePath: string;
      sha256?: string;
      requiredSha256?: string;
    };

export type ProtocolPaths = { forgeHome?: string; seedsDir?: string };

const REMEDY = "run `forge upgrade` (it adopts and publishes the Forge-owned protocol region), then retry";

/** Two independent reads: REQUIRED from the executing release, INSTALLED from
 *  $FORGE_HOME. Never one restating the other. */
export function resolveAgentProtocol(role: string, paths: ProtocolPaths = {}): ProtocolResolution {
  const installedPath = installedSeedPath(role, paths.forgeHome ?? forgeHomeDefault());
  const releasePath = releaseSeedPath(role, paths.seedsDir ?? releaseSeedsDirDefault());
  const base = { role, installedPath, releasePath };

  if (!existsSync(releasePath)) {
    return {
      ...base,
      ok: false,
      reason: "release_missing",
      refusal:
        `agent role "${role}" is covered by the Forge-owned review protocol, but this release carries no seed ` +
        `for it at ${releasePath}. The release is incomplete; nothing was dispatched.`,
    };
  }
  const required = readProtocolRegion(readFileSync(releasePath, "utf8"));
  if (required.kind !== "fenced") {
    return {
      ...base,
      ok: false,
      reason: "release_unfenced",
      refusal:
        `agent role "${role}"'s release seed at ${releasePath} carries no balanced ` +
        `${PROTOCOL_START_MARKER} / ${PROTOCOL_END_MARKER} pair, so there is no required protocol generation to ` +
        `check against. The release is incomplete; nothing was dispatched.`,
    };
  }
  const requiredSha256 = protocolSha256(required.region);

  // D5: ABSENT and STALE are the same class of unmet precondition. compose.ts used to
  // fail OPEN here — it substituted a "(Agent base CLAUDE.md not found…)" placeholder and
  // dispatched an agent with no role contract at all, which is strictly worse than a
  // stale one.
  if (!existsSync(installedPath)) {
    return {
      ...base,
      ok: false,
      reason: "installed_missing",
      requiredSha256,
      refusal:
        `agent role "${role}" has NO installed seed at ${installedPath}, so it carries none of the review ` +
        `protocol this release requires (${requiredSha256}). Dispatching it would run a reviewer that was never ` +
        `told the contract its output is judged by. Remedy: ${REMEDY}.`,
    };
  }
  const installed = readProtocolRegion(readFileSync(installedPath, "utf8"));
  if (installed.kind === "unbalanced") {
    return {
      ...base,
      ok: false,
      reason: "installed_unbalanced",
      requiredSha256,
      refusal:
        `agent role "${role}"'s installed seed at ${installedPath} has an ambiguous protocol fence ` +
        `(${installed.detail}), so forge cannot tell which bytes are the Forge-owned protocol. Repair the ` +
        `markers by hand — exactly one ${PROTOCOL_START_MARKER} and one ${PROTOCOL_END_MARKER} after it — then ` +
        `${REMEDY}.`,
    };
  }
  if (installed.kind === "unfenced") {
    return {
      ...base,
      ok: false,
      reason: "installed_unfenced",
      requiredSha256,
      refusal:
        `agent role "${role}"'s installed seed at ${installedPath} carries NO Forge-owned protocol region ` +
        `(required ${requiredSha256}) — it predates FG-654 and was never adopted. Remedy: ${REMEDY}.`,
    };
  }
  const sha256 = protocolSha256(installed.region);
  if (sha256 !== requiredSha256) {
    return {
      ...base,
      ok: false,
      reason: "stale",
      sha256,
      requiredSha256,
      refusal:
        `agent role "${role}" would run a STALE review protocol: installed ${sha256} at ${installedPath}, ` +
        `this release requires ${requiredSha256} from ${releasePath}. A stale reviewer does not fail loudly — ` +
        `it produces plausible output in the wrong shape — so the dispatch is refused instead. Remedy: ${REMEDY}.`,
    };
  }
  return { ...base, ok: true, sha256, requiredSha256 };
}

export type ProtocolAssertion =
  | { ok: true; stamp?: AgentProtocolStamp }
  | { ok: false; role: string; refusal: string };

/** The dispatch-time gate. ROLE-KEYED, so it gates every lifecycle that dispatches a
 *  covered role off the same seed — including the legacy review-loop's red-wide — and is
 *  not forgeable by dispatching through the other mode. Uncovered roles (synthesizer,
 *  tech-lead, the specialists) are untouched. */
export function assertAgentProtocolCurrent(role: string, paths: ProtocolPaths = {}): ProtocolAssertion {
  if (!isCoveredRole(role)) return { ok: true };
  const resolved = resolveAgentProtocol(role, paths);
  if (!resolved.ok) return { ok: false, role, refusal: resolved.refusal };
  return { ok: true, stamp: { role, sha256: resolved.sha256, source: resolved.installedPath } };
}

// There is deliberately NO `agentProtocolStamp(role)` helper here. The stamp a manifest
// records must be the one the COMPOSE that produced the prompt resolved — it rides
// TaskPackage.agentProtocol from there to writeTaskManifest. A function that re-derives it
// from a role is a second disk read minutes later: it can name a generation the container
// was never given, or return undefined for a covered role that did dispatch, and either
// way the receipt asserts something untrue about the run.

// ─── reporting + publication ────────────────────────────────────────────────

/** Read-only, one entry per covered role. `forge doctor` and `forge upgrade` both
 *  consume this rather than each re-deriving the comparison. */
export function inspectAgentProtocols(paths: ProtocolPaths = {}): ProtocolResolution[] {
  return COVERED_ROLES.map((role) => resolveAgentProtocol(role, paths));
}

export type PublishOutcome = {
  role: string;
  path: string;
  action:
    | "created"
    | "replaced"
    | "adopted"
    | "appended"
    | "unchanged"
    | "needs-markers"
    | "release-missing"
    | "unsafe-path";
  message?: string;
  /** set when a pre-adoption copy was written because an excised section differed */
  backupPath?: string;
};

const PUBLISH_STAGING_SUFFIX = ".forge-publish-tmp";

/** Commit a seed with a temp file and a single `rename(2)`, the way `publishSeedGeneration`
 *  commits a generation. A plain truncating write leaves a zero-length or half-written
 *  CLAUDE.md if the process dies between truncate and write — and `resolveAgentProtocol`
 *  and `composeSystemPrompt` read this file on EVERY dispatch, so a concurrent `forge next`
 *  can observe the torn intermediate, not just the interrupted upgrade. */
function writeSeedAtomically(path: string, content: string): void {
  const tmp = `${path}${PUBLISH_STAGING_SUFFIX}`;
  // Unlink first, so this writes a file we created: writeFileSync FOLLOWS a symlink at
  // the staging path, and rename(2) would then leave the seed itself a link aimed
  // outside the tree. The guard below refuses that plant, but the guard runs before
  // this write; removing the entry closes the window rather than narrowing it.
  rmSync(tmp, { force: true });
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** A symlink at a path this pass writes redirects the write out of the seed tree, so a
 *  hostile or salvaged $FORGE_HOME could aim an upgrade at any file the operator can
 *  write. Refuse rather than resolve: there is no legitimate reason for a seed or its
 *  backup to be a link, and following one is not a decision forge gets to make silently. */
function symlinkAt(path: string): boolean {
  // lstat, and NOT existsSync first: existsSync follows the link, so a dangling one —
  // the easiest to plant — reads as absent and would take the create path.
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

/** THE SINGLE PUBLISHER. install-seeds.sh performs no marker or region surgery — its
 *  AUTHORED_EXEMPT stays whole-file and category-granular, so forge-raci.md and the
 *  operator's own agent prose keep working exactly as they did. A host that has never
 *  run forge gets an already-fenced file from the installer's plain copy and is correct
 *  by construction; an existing host is migrated HERE, as part of the upgrade that
 *  introduces the requirement. */
export function publishAgentProtocolRegions(
  opts: ProtocolPaths & { dryRun?: boolean } = {},
): PublishOutcome[] {
  const seedsDir = opts.seedsDir ?? releaseSeedsDirDefault();
  const forgeHome = opts.forgeHome ?? forgeHomeDefault();
  const out: PublishOutcome[] = [];

  for (const role of COVERED_ROLES) {
    const releasePath = releaseSeedPath(role, seedsDir);
    const installPath = installedSeedPath(role, forgeHome);
    if (!existsSync(releasePath)) {
      out.push({
        role,
        path: installPath,
        action: "release-missing",
        message: `this release carries no seed at ${releasePath}`,
      });
      continue;
    }
    const releaseText = readFileSync(releasePath, "utf8");
    const releaseRegion = readProtocolRegion(releaseText);
    if (releaseRegion.kind !== "fenced") {
      out.push({
        role,
        path: installPath,
        action: "release-missing",
        message: `${releasePath} carries no balanced protocol fence, so there is nothing to publish`,
      });
      continue;
    }

    const backupPathFor = `${installPath}${PRE_ADOPTION_BACKUP_SUFFIX}`;
    // EVERY path this pass may write, not just the two destinations: each write is
    // committed through a staging file, and a link there redirects the write just as
    // effectively — with the seed left a link too, since rename(2) moves the link.
    const writablePaths = [installPath, backupPathFor].flatMap((p) => [
      p,
      `${p}${PUBLISH_STAGING_SUFFIX}`,
    ]);
    const linked = writablePaths.find(symlinkAt);
    if (linked !== undefined) {
      out.push({
        role,
        path: installPath,
        action: "unsafe-path",
        message:
          `${linked} is a symbolic link. Publishing through it ` +
          `would write this release's protocol region — or a copy of the seed — to wherever it points, outside ` +
          `the seed tree. Replace the link with a real file. Nothing was written.`,
      });
      continue;
    }

    if (!existsSync(installPath)) {
      if (!opts.dryRun) {
        mkdirSync(dirname(installPath), { recursive: true });
        writeSeedAtomically(installPath, releaseText);
      }
      out.push({ role, path: installPath, action: "created" });
      continue;
    }

    const existing = readFileSync(installPath, "utf8");
    const applied = applyProtocolRegion(existing, releaseRegion.region);
    if (applied.action === "needs-markers") {
      out.push({ role, path: installPath, action: "needs-markers", message: applied.message });
      continue;
    }
    if (applied.action === "unchanged") {
      out.push({ role, path: installPath, action: "unchanged" });
      continue;
    }
    // The .bak is part of the safety argument, so it is written on every lossy path —
    // adoption AND the fenced splice, each only when the bytes they discard differed.
    const backupPath = applied.excisedChanged ? backupPathFor : undefined;
    if (!opts.dryRun) {
      if (backupPath) writeSeedAtomically(backupPath, existing);
      writeSeedAtomically(installPath, applied.content);
    }
    out.push({
      role,
      path: installPath,
      action: applied.action,
      ...(backupPath ? { backupPath } : {}),
    });
  }
  return out;
}

/** The one-line human summary `forge upgrade` prints. Names every file that needs a
 *  hand repair and every backup written, because both are things the operator must
 *  read rather than discover later. */
export function renderProtocolPublication(outcomes: readonly PublishOutcome[]): string[] {
  const lines: string[] = [];
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o.action, (counts.get(o.action) ?? 0) + 1);
  const summary = [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ");
  lines.push(`agent protocol region: ${summary}`);
  for (const o of outcomes) {
    if (o.backupPath) lines.push(`  pre-publication copy of ${o.role} saved to ${o.backupPath}`);
    // ⚠ is reserved for the state the OPERATOR must act on. `release-missing` is the
    // executing tree's problem, not theirs, and no upgrade on this host converges it — it
    // is reported plainly here, and it is still a doctor FAIL and a dispatch refusal.
    if (o.action === "needs-markers" || o.action === "unsafe-path") lines.push(`  ⚠ ${o.path}: ${o.message}`);
    if (o.action === "release-missing") lines.push(`  ${o.role}: ${o.message}`);
  }
  return lines;
}

// #229: release-readiness diagnostics. A new/work laptop must be diagnosable
// BEFORE real work runs — the failure mode this fixes is a seed (e.g.
// codex-subscription) that RESOLVES fine while the agent image lacks the `codex`
// CLI, so the container dies at exec with no hint the image is stale.
//
// This module is the PURE core: buildReleaseReport() takes already-gathered raw
// inputs and assembles a structured report. All IO (docker inspect, docker run
// CLI probes, policy load, auth probe, route validate) happens in the CLI wiring
// (src/cli/commands/doctor.ts) and is passed in here — so every scenario (image
// missing/stale, CLI missing, credential missing, green) is unit-testable with
// plain fixtures and no docker/DB. Read-only by construction: it computes a
// report, never mutates.

import type { ExecutionMode } from "./asset-root.js";
import { compareVersions, requiredClaudeCliVersion } from "./claude-cli-floor.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export type ReleaseCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Concrete next command to fix a warn/fail, when there is one. */
  next?: string;
};

export type ReleaseReport = {
  checks: ReleaseCheck[];
  /** false if ANY check is "fail" — warns/skips do not flip it. */
  ok: boolean;
};

// ── Raw inputs (gathered by the CLI; no IO in this module) ───────────────────

export type ImageInputs = {
  name: string;
  present: boolean;
  /** FG-543: the build-input CONTENT digest recorded on the image as the
   *  `forge.build-inputs.digest` LABEL at build time. Undefined/empty when the
   *  label is absent — an image built before the digest label (or by hand). The
   *  check fails toward STALE on absence (AC4). */
  recordedDigest?: string;
  /** FG-543: the digest freshly computed from the executing tree's build inputs
   *  (computeBuildInputDigest). Compared against recordedDigest to decide
   *  staleness. Undefined when the tree's docker/ couldn't be read. */
  currentInputDigest?: string;
  /** Set when docker itself couldn't be probed (daemon down / not installed) —
   *  distinct from a genuine "No such image". Makes the check skip, not fail, so
   *  a transient daemon hiccup never tells the user to rebuild a present image. */
  dockerError?: string;
};

export type CliInputs = {
  command: string;            // e.g. "codex"
  /** true present, false absent, null = couldn't probe (image missing / docker unavailable). */
  present: boolean | null;
  neededBy: string[];         // runtime names that need this CLI, e.g. ["codex-subscription"]
};

/** FG-804: the in-image Claude Code version against the models it may be asked to
 *  serve. `not-probed` = the image or the claude CLI is unavailable (their own
 *  checks already report that); `unreadable` = the CLI is present but
 *  `claude --version` could not be run or parsed. */
export type ClaudeCliVersionInputs = {
  probe:
    | { kind: "version"; version: string }
    | { kind: "unreadable"; detail: string }
    | { kind: "not-probed" };
  /** Every model the effective host model policy / claude runtime aliases can
   *  resolve to on the claude CLI, with where it came from. */
  models: Array<{ model: string; source: string }>;
};

export type PolicyInputs = {
  present: boolean;           // model-policy.yml exists?
  valid: boolean;             // parses + passes schema?
  error?: string;
};

export type AuthInputs = {
  profile: string;
  provider: string;
  auth: string;               // effective auth (subscription | api | bedrock)
  status: "available" | "unavailable" | "unknown";
  detail: string;
  /** Default-reachable = selected by defaults.profile / defaults.activity /
   *  overrides.agents (so it runs without an explicit --profile). A missing cred
   *  on a reachable profile blocks (fail); on an opt-in-only profile it warns.
   *  Defaults to true (treat as blocking) when omitted. */
  reachable?: boolean;
  /** FG-796: the SOURCES that make this profile default-reachable, so the advice can
   *  name WHY it blocks — e.g. ["defaults.profile", "defaults.activity.review",
   *  "overrides.agents.red-wide"]. Empty/undefined for an opt-in-only profile. */
  reachableVia?: string[];
  /** FG-796: names of OTHER profiles of the SAME provider that ARE available on this
   *  host. When non-empty, a missing cred is repaired by re-pointing to one of these
   *  (`forge setup --reconfigure`), NOT by `forge auth login`. */
  sameProviderAvailable?: string[];
};

export type RoutingInputs = {
  present: boolean;
  ok: boolean;
  detail: string;
};

export type ReleaseInputs = {
  image: ImageInputs;
  clis: CliInputs[];
  /** FG-804: absent when no configured runtime runs the claude CLI. */
  claudeCli?: ClaudeCliVersionInputs;
  policy: PolicyInputs;
  profileAuth: AuthInputs[];
  routing: RoutingInputs;
  /** FG-577: how this forge is executing. Required rather than defaulted — it
   *  selects both the staleness heuristic and the rebuild command the advice may
   *  name, and "dev" is exactly the answer that misfires on a release host. */
  mode: ExecutionMode;
};

const REBUILD_DEV = "rebuild the agent image: docker/build.sh (or `forge upgrade --rebuild-image`)";
// FG-577: `forge upgrade --rebuild-image` REFUSES under a release (upgrade.ts) —
// rebuilding is dev-advancement. Advice that names a command which refuses in the
// very mode it is offered in is a dead end, not a next step, so a release host is
// pointed at the checkout-side command instead.
const REBUILD_RELEASE = "rebuild the agent image from a dev checkout: `forge-dev upgrade --rebuild-image` (a release cannot rebuild its own image)";

function rebuildAdvice(mode: ExecutionMode): string {
  return mode === "release" ? REBUILD_RELEASE : REBUILD_DEV;
}

function imageCheck(img: ImageInputs, mode: ExecutionMode): ReleaseCheck {
  if (img.dockerError) {
    return { name: `image ${img.name}`, status: "skip", detail: `could not probe docker (${img.dockerError})`, next: "ensure docker is running, then re-run `forge doctor`" };
  }
  if (!img.present) {
    return { name: `image ${img.name}`, status: "fail", detail: "not built on this host", next: rebuildAdvice(mode) };
  }
  // FG-543: staleness is a CONTENT-digest comparison, not mtime-vs-created. The
  // Dockerfile + its source-controlled COPYed files are hashed identically at
  // build time (recorded as the `forge.build-inputs.digest` label) and at check
  // time (recomputed from the executing tree). This is correct in BOTH modes:
  // content, not timestamps, so a release's cpSync-restamped inputs (the FG-577
  // false STALE) and a fully-cached rebuild (new ID, old `created`) both judge
  // correctly. FG-577's mode gate dissolves — a release whose build-input content
  // matches the recorded digest is simply not stale.
  const recorded = img.recordedDigest?.trim();
  if (!recorded) {
    // AC4: fail toward STALE when the digest record is absent. Pre-label images
    // (built before this label existed, or by hand) stay flagged until rebuilt
    // once — the rebuild is what records the digest.
    return {
      name: `image ${img.name}`,
      status: "warn",
      detail: "STALE — no build-input content digest is recorded on this image (built before the digest label, or by hand); rebuild once to record it",
      next: rebuildAdvice(mode),
    };
  }
  // currentInputDigest is undefined only when the executing tree's docker/ can't
  // be read; with no current digest to compare, an absence of proof of staleness
  // is not proof of staleness, so this stays ok rather than a false STALE.
  if (img.currentInputDigest !== undefined && recorded !== img.currentInputDigest) {
    return {
      name: `image ${img.name}`,
      status: "warn",
      detail: "STALE — the build-input content digest differs from the digest recorded on the image at build time; a build input's content changed, so runtime CLIs/deps/wrappers may be out of date",
      next: rebuildAdvice(mode),
    };
  }
  return {
    name: `image ${img.name}`,
    status: "ok",
    detail: "present; build-input content matches the digest recorded at build time",
  };
}

function cliCheck(c: CliInputs, mode: ExecutionMode): ReleaseCheck {
  const who = c.neededBy.length > 0 ? ` (needed by ${c.neededBy.join(", ")})` : "";
  if (c.present === null) {
    return { name: `cli ${c.command}`, status: "skip", detail: `not probed${who} — image unavailable`, next: rebuildAdvice(mode) };
  }
  if (c.present === false) {
    return { name: `cli ${c.command}`, status: "fail", detail: `missing from the image${who} — a dispatch will die at exec`, next: rebuildAdvice(mode) };
  }
  return { name: `cli ${c.command}`, status: "ok", detail: `present in the image${who}` };
}

const PIN_ADVICE = "if CLAUDE_CODE_VERSION in docker/agent-dev-worker.Dockerfile is itself below the floor, bump it first";

function claudeCliVersionCheck(c: ClaudeCliVersionInputs, mode: ExecutionMode): ReleaseCheck {
  const name = "claude CLI version";
  const floored = new Map<string, { required: string; sources: string[] }>();
  for (const { model, source } of c.models) {
    const required = requiredClaudeCliVersion(model);
    if (!required) continue;
    const entry = floored.get(model) ?? { required, sources: [] };
    entry.sources.push(source);
    floored.set(model, entry);
  }
  if (c.probe.kind === "not-probed") {
    return { name, status: "skip", detail: "not probed — the image or its claude CLI is unavailable" };
  }
  if (c.probe.kind === "unreadable") {
    // AC4: an unknown version is reported, never a silent pass. It blocks only when
    // some configured model actually has a floor the unknown version might miss.
    const detail = `could not determine the in-image Claude Code version (${c.probe.detail})`;
    return floored.size > 0
      ? { name, status: "fail", detail: `${detail}; cannot verify floors for ${[...floored.keys()].join(", ")}`, next: rebuildAdvice(mode) }
      : { name, status: "warn", detail, next: rebuildAdvice(mode) };
  }
  const version = c.probe.version;
  const short = [...floored].filter(([, f]) => compareVersions(version, f.required) < 0);
  if (short.length > 0) {
    const what = short
      .map(([model, f]) => `${model} (${f.sources.join(", ")}) requires Claude Code >= ${f.required}`)
      .join("; ");
    return {
      name,
      status: "fail",
      detail: `image has Claude Code ${version}, too old for the configured models: ${what} — those dispatches will fail at the API`,
      next: `${rebuildAdvice(mode)}; ${PIN_ADVICE}`,
    };
  }
  const floors = floored.size > 0 ? `meets every configured model floor (${[...floored.keys()].join(", ")})` : "no configured model declares a version floor";
  return { name, status: "ok", detail: `image has Claude Code ${version}; ${floors}` };
}

function policyCheck(p: PolicyInputs): ReleaseCheck {
  if (!p.present) {
    return { name: "model-policy.yml", status: "ok", detail: "absent — legacy resolution (runtime.models[alias]); not an error" };
  }
  if (!p.valid) {
    return { name: "model-policy.yml", status: "fail", detail: `present but INVALID: ${p.error ?? "parse/schema error"}`, next: "fix model-policy.yml (see `forge model resolve --check`)" };
  }
  return { name: "model-policy.yml", status: "ok", detail: "present and valid" };
}

function authCheck(a: AuthInputs): ReleaseCheck {
  const label = `auth ${a.profile} (${a.provider}/${a.auth})`;
  if (a.status === "available") return { name: label, status: "ok", detail: a.detail };
  if (a.status === "unavailable") {
    // A default-reachable profile with no cred blocks; an opt-in-only profile
    // (selected only via --profile) just warns — it can't break default work.
    if (a.reachable === false) {
      const next = `provide the credential for ${a.provider}/${a.auth} before dispatching this profile`;
      return { name: label, status: "warn", detail: `${a.detail} — opt-in profile (only runs when selected via --profile)`, next };
    }
    // FG-796: name WHY it is reachable (the policy sources), then give an advice
    // that fits this host, not a blanket `forge auth login`.
    const via = a.reachableVia ?? [];
    const whyReachable = via.length > 0 ? ` — reachable via ${via.join(", ")}` : "";
    const sameProvider = a.sameProviderAvailable ?? [];
    const pinSources = via.filter((v) => v.startsWith("overrides.agents."));
    let next: string;
    if (sameProvider.length > 0) {
      // Another profile of the SAME provider works here — re-point to it rather than
      // chasing a credential for an auth this host does not use.
      next =
        `re-point to an available ${a.provider} profile (${sameProvider.join(", ")}) with ` +
        `\`forge setup --reconfigure\`, or set this profile's auth: auto`;
    } else if (pinSources.length > 0 && pinSources.length === via.length) {
      // Reachable ONLY through agent pins and no same-provider alternative exists:
      // the fix is to remove/re-point the pin(s) by name, not to obtain a credential.
      next = `remove or re-point the pin(s) naming this profile: ${pinSources.join(", ")}`;
    } else {
      // Reached through defaults with no same-provider alternative — the credential
      // genuinely has to be provided (`forge auth login` for subscription auth).
      next = `provide the credential for ${a.provider}/${a.auth} (e.g. \`forge auth login\`) — no other available ${a.provider} profile to re-point to`;
    }
    return { name: label, status: "fail", detail: `${a.detail}${whyReachable}`, next };
  }
  // unknown: not determinable from the host (OAuth in a docker volume, or a
  // provider/auth with no host-side probe) — flag, never block.
  return { name: label, status: "warn", detail: `${a.detail} (not checkable from the host)` };
}

function routingCheck(r: RoutingInputs): ReleaseCheck {
  if (!r.present) {
    return { name: "routing-policy.yml", status: "warn", detail: "absent — orchestrator routing not compiled on this host", next: "run `forge upgrade` to compile it from the RACI" };
  }
  if (!r.ok) {
    return { name: "routing-policy.yml", status: "fail", detail: r.detail, next: "run `forge route validate` and recompile" };
  }
  return { name: "routing-policy.yml", status: "ok", detail: r.detail || "present and validates" };
}

export function buildReleaseReport(inp: ReleaseInputs): ReleaseReport {
  const checks: ReleaseCheck[] = [
    imageCheck(inp.image, inp.mode),
    ...inp.clis.map((c) => cliCheck(c, inp.mode)),
    ...(inp.claudeCli ? [claudeCliVersionCheck(inp.claudeCli, inp.mode)] : []),
    policyCheck(inp.policy),
    ...inp.profileAuth.map(authCheck),
    routingCheck(inp.routing),
  ];
  return { checks, ok: checks.every((c) => c.status !== "fail") };
}

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "?" };

export function renderReleaseReport(report: ReleaseReport): string {
  const lines = ["Release readiness:"];
  for (const c of report.checks) {
    lines.push(`  ${ICON[c.status]} ${c.name.padEnd(34)} ${c.detail}`);
    if (c.next && (c.status === "fail" || c.status === "warn" || c.status === "skip")) {
      lines.push(`      → ${c.next}`);
    }
  }
  lines.push("");
  lines.push(report.ok ? "Overall: OK (no blocking failures)." : "Overall: NOT READY — blocking failures above.");
  return lines.join("\n");
}

// Just the actionable lines (fail/warn/skip), for forge upgrade's tail warning.
export function summarizeProblems(report: ReleaseReport): string[] {
  return report.checks
    .filter((c) => c.status !== "ok")
    .map((c) => `${ICON[c.status]} ${c.name}: ${c.detail}${c.next ? ` → ${c.next}` : ""}`);
}

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
  /** image creation time (ms) — undefined when absent. */
  createdMs?: number;
  /** Newest mtime (ms) across the image's build inputs — the Dockerfile and every
   *  file it COPYs (forge-test.sh, agent-entrypoint.sh). Undefined when the source
   *  repo isn't locatable. */
  buildInputMtimeMs?: number;
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
};

export type RoutingInputs = {
  present: boolean;
  ok: boolean;
  detail: string;
};

export type ReleaseInputs = {
  image: ImageInputs;
  clis: CliInputs[];
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
  // FG-577: under a release the mtime comparison is a category error, not a
  // conservative guess. Release trees are materialized with cpSync (release.ts),
  // which does not preserve timestamps — so every build input is stamped at
  // release-build time and reads as newer than any image built before it. That
  // makes STALE permanent on a release host, and the only remedy it could name
  // refuses there. Presence is the honest check; the heuristic's wider
  // false-positive class is FG-543, not this ticket.
  if (mode === "dev" && img.buildInputMtimeMs !== undefined && img.createdMs !== undefined && img.buildInputMtimeMs > img.createdMs) {
    return {
      name: `image ${img.name}`,
      status: "warn",
      detail: "STALE — a build input (Dockerfile or a COPYed script, e.g. forge-test.sh) is newer than the built image; runtime CLIs/deps/wrappers may be out of date",
      next: rebuildAdvice(mode),
    };
  }
  return {
    name: `image ${img.name}`,
    status: "ok",
    detail: mode === "release"
      ? "present (a release's build-input mtimes are stamped at release time, so staleness is not judged from them — FG-543)"
      : "present and not older than its build inputs (Dockerfile + COPYed scripts)",
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
    const next = `provide the credential for ${a.provider}/${a.auth} before dispatching this profile`;
    // A default-reachable profile with no cred blocks; an opt-in-only profile
    // (selected only via --profile) just warns — it can't break default work.
    if (a.reachable === false) {
      return { name: label, status: "warn", detail: `${a.detail} — opt-in profile (only runs when selected via --profile)`, next };
    }
    return { name: label, status: "fail", detail: a.detail, next };
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

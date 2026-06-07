// #252: new-host / new-machine readiness. install-seeds installs
// model-policy.EXAMPLE.yml but never the active model-policy.yml (by design —
// installing the example must not flip resolution into policy mode). So a fresh
// host stays in legacy mode until someone hand-copies YAML. `forge setup` closes
// that gap: it guided-creates the active host config from the seed (the one safe,
// host-local, never-committed mutation), ensures the routing policy, runs the
// #229 read-only release check, and reports whether the Codex review-loop path is
// configured — all without a live agent run.
//
// This module is the PURE core: decisions + report assembly from already-gathered
// inputs. All IO (file copy, ensure-routing, docker probes) lives in the CLI
// wiring (src/cli/commands/setup.ts) and is injected, so every branch is unit-
// testable with plain fixtures.

import type { CheckStatus, ReleaseCheck, ReleaseReport, ReleaseInputs } from "./release-doctor.js";

export type SetupStepStatus = CheckStatus | "created" | "would-create";

export type SetupStep = {
  name: string;
  status: SetupStepStatus;
  detail: string;
  next?: string;
};

export type SetupReport = {
  steps: SetupStep[];
  /** false if any step is a hard "fail" — created/would-create/warn/skip do not block. */
  ready: boolean;
};

// ── Guided host-config provisioning (decision only; the copy is done by the CLI) ──

export type ProvisionAction = "present" | "created" | "would-create" | "no-seed";

/** Decide what to do about an absent active config given a seed to copy from.
 *  Never overwrites a present config (preserves host-local personal edits). */
export function planConfigProvision(opts: {
  activePresent: boolean;
  seedPresent: boolean;
  dryRun?: boolean;
}): ProvisionAction {
  if (opts.activePresent) return "present";
  if (!opts.seedPresent) return "no-seed";
  return opts.dryRun ? "would-create" : "created";
}

export function modelPolicyStep(action: ProvisionAction): SetupStep {
  const name = "model-policy.yml";
  switch (action) {
    case "present":
      return { name, status: "ok", detail: "active host policy present (preserved — not overwritten)" };
    case "created":
      return { name, status: "created", detail: "created active host policy from model-policy.example.yml (edit it to taste; not committed)" };
    case "would-create":
      return { name, status: "would-create", detail: "absent — would create from model-policy.example.yml", next: "run `forge setup` (without --dry-run) to create it" };
    case "no-seed":
      return { name, status: "fail", detail: "absent and no model-policy.example.yml seed found", next: "run `forge upgrade` to install seeds first" };
  }
}

export function routingPolicyStep(opts: { presentBefore: boolean; ensuredOk: boolean; detail: string }): SetupStep {
  const name = "routing-policy.yml";
  if (!opts.ensuredOk) {
    return { name, status: "fail", detail: opts.detail || "could not compile routing policy from the RACI", next: "run `forge upgrade` (recompiles routing-policy) and `forge route validate`" };
  }
  return {
    name,
    status: opts.presentBefore ? "ok" : "created",
    detail: opts.presentBefore ? "present and compiled" : "compiled from the RACI seed",
  };
}

// ── Codex review-loop path readiness (no live agent) ──

/** Is `forge review-loop --review-profile <reviewerProfile>` runnable on this host,
 *  verified statically: the profile is defined + its auth is available, AND the
 *  codex CLI is present in the image. Non-blocking (warn) — it's an opt-in path,
 *  not default-work readiness. */
export function reviewLoopReadiness(inputs: ReleaseInputs, reviewerProfile = "codex-subscription"): ReleaseCheck {
  const name = `review-loop reviewer (${reviewerProfile})`;
  const gaps: string[] = [];

  const profile = inputs.profileAuth.find((p) => p.profile === reviewerProfile);
  if (!profile) gaps.push(`profile '${reviewerProfile}' not defined in model-policy`);
  else if (profile.status === "unavailable") gaps.push(`${reviewerProfile} auth unavailable (${profile.detail})`);
  else if (profile.status === "unknown") gaps.push(`${reviewerProfile} auth not verifiable from host`);

  const codex = inputs.clis.find((c) => c.command === "codex");
  if (!codex) gaps.push("no codex runtime seeded");
  else if (codex.present === false) gaps.push("codex CLI missing from the image");
  else if (codex.present === null) gaps.push("codex CLI not probed (image/docker unavailable)");

  if (gaps.length === 0) {
    return { name, status: "ok", detail: `configured — ${reviewerProfile} available + codex CLI present (verified statically, no agent run)` };
  }
  return {
    name,
    status: "warn",
    detail: gaps.join("; "),
    next: `resolve the above to use \`forge review-loop --review-profile ${reviewerProfile}\``,
  };
}

// ── Report assembly ──

export function buildSetupReport(
  provisioning: SetupStep[],
  release: ReleaseReport,
  reviewLoop: ReleaseCheck,
): SetupReport {
  const releaseSteps: SetupStep[] = release.checks.map((c) => ({ name: c.name, status: c.status, detail: c.detail, ...(c.next ? { next: c.next } : {}) }));
  const reviewStep: SetupStep = { name: reviewLoop.name, status: reviewLoop.status, detail: reviewLoop.detail, ...(reviewLoop.next ? { next: reviewLoop.next } : {}) };
  const steps = [...provisioning, ...releaseSteps, reviewStep];
  return { steps, ready: steps.every((s) => s.status !== "fail") };
}

const ICON: Record<SetupStepStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "?", created: "+", "would-create": "+" };

export function renderSetupReport(report: SetupReport): string {
  const lines = ["forge setup — new-host readiness:"];
  for (const s of report.steps) {
    lines.push(`  ${ICON[s.status]} ${s.name.padEnd(34)} ${s.detail}`);
    if (s.next && (s.status === "fail" || s.status === "warn" || s.status === "would-create" || s.status === "skip")) {
      lines.push(`      → ${s.next}`);
    }
  }
  lines.push("");
  lines.push(report.ready ? "Ready: no blocking failures (warnings are opt-in / follow-up)." : "NOT READY — blocking failures above.");
  return lines.join("\n");
}

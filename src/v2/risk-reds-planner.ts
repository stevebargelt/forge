// FG-385: the RISK-TARGETED REDS PLANNER for the Shipping Reviewer. A bounded,
// deterministic, PURE planner over the existing review contract vocabulary — no new agent
// role, no model call, no new review cycle, no second evidence ledger.
//
// IT IS STRICTLY ADVISORY, AND THAT IS THE WHOLE POINT (review-contract.ts:19-42). This
// module RECOMMENDS lenses and per-lens attack specs for the orchestrator to AUTHOR into
// the contract, and it ANNOTATES the Reviewer Context Packet. It does NOT auto-author or
// auto-confirm a contract, never touches any confirmContract path, and never changes the
// widening asymmetry. `selectRedsForContract` (review-contract.ts:126) remains the sole
// authority over which reds actually run off the AUTHORED contract.
//
// AND IT IS NOT A PATH CLASSIFIER. Nothing here reads a diff or a filename and decides
// "this path looks like security". The ORCHESTRATOR classifies its change into the risk
// signals below (a human/coordinator saying "this change touches lifecycle") and hands
// them in; this module maps a NAMED signal to the lens + attack spec a reviewer should be
// pointed at. The direction of inference is the PRD's line: an authored signal is an input,
// a filename-sniffing classifier is the thing the PRD refuses (review-contract.ts:23-35).
//
// THE ONE TAXONOMY TABLE LIVES ONLY HERE (fg385-risk-taxonomy-source-guard.test.ts). A
// second risk-signal→lens mapping literal anywhere else is a two-renderings defect: the
// planner recommends one panel and the copy recommends another. The guard scans for the
// `risk-signal:` vocabulary and refuses it outside this module.

import type { RiskLens } from "./review-contract.js";
import { RISK_LENSES, lensRole } from "./review-contract.js";

// The risk-signal vocabulary. Namespaced with `risk-signal:` so the source guard can find
// every reference to the taxonomy and refuse a second copy; each literal appears exactly
// once (here), and everything downstream refers to the named const, never the string.
const S_LIFECYCLE = "risk-signal:lifecycle-reconciliation";
const S_GIT_PUBLICATION = "risk-signal:git-worktree-publication";
const S_AUTH_CREDENTIAL = "risk-signal:auth-credential-secret";
const S_ROUTING_POLICY = "risk-signal:routing-policy-runtime";
const S_DB_STATE = "risk-signal:db-durable-state";
const S_TEST_INFRA = "risk-signal:test-validation-infra";
const S_DONE_GATE = "risk-signal:done-gate-change";
const S_DASHBOARD = "risk-signal:dashboard-decision-surface";
const S_CROSS_MODULE = "risk-signal:cross-module-contract";
const S_DOCS_ONLY = "risk-signal:docs-only";

export const RISK_SIGNALS = [
  S_LIFECYCLE,
  S_GIT_PUBLICATION,
  S_AUTH_CREDENTIAL,
  S_ROUTING_POLICY,
  S_DB_STATE,
  S_TEST_INFRA,
  S_DONE_GATE,
  S_DASHBOARD,
  S_CROSS_MODULE,
  S_DOCS_ONLY,
] as const;

export type RiskSignal = (typeof RISK_SIGNALS)[number];

export function isRiskSignal(s: string): s is RiskSignal {
  return (RISK_SIGNALS as readonly string[]).includes(s);
}

/** The blocker-biased classes the AC requires to be explicit in the output — the failure
 *  families that make a lens a HARD blocker rather than a fail-safe nicety. */
export const BLOCKER_CLASSES = [
  "data_loss",
  "wedged_state",
  "fake_validation",
  "credential_leakage",
  "non_atomic_state",
  "silent_success",
] as const;

export type BlockerClass = (typeof BLOCKER_CLASSES)[number];

/** One lens's attack spec for a single risk signal: the invariant under attack, the
 *  concrete failure modes a reviewer should try, the evidence a resolution must carry, and
 *  which blocker-biased classes are in play. Paths are attached at plan time from the
 *  authored `changedPathClasses`, not stored in the taxonomy. */
type LensAttack = {
  invariant: string;
  failureModes: string[];
  evidenceStandard: string;
  blockerClasses: BlockerClass[];
};

type TaxonomyEntry = {
  lenses: Partial<Record<RiskLens, LensAttack>>;
};

// THE ONE TAXONOMY. change-class/risk-signal → lens + invariant/failure-modes/evidence.
// `docs-only` is deliberately absent: it is the low-risk classification handled below, not
// a lens selection.
const RISK_REDS_TAXONOMY: Record<Exclude<RiskSignal, typeof S_DOCS_ONLY>, TaxonomyEntry> = {
  [S_LIFECYCLE]: {
    lenses: {
      backend: {
        invariant:
          "run/task lifecycle state is derived once and terminal states never silently regress; reconciliation is idempotent and converges",
        failureModes: [
          "a task wedged non-terminal with no path forward",
          "a terminal state re-entered or double-counted",
          "reconciliation that is not idempotent on replay",
          "orphaned children after a parent terminates",
        ],
        evidenceStandard:
          "a regression test that drives the state machine through the wedge/regress path and asserts convergence at the candidate sha",
        blockerClasses: ["wedged_state", "non_atomic_state", "silent_success"],
      },
      narrow: {
        invariant: "the specific state transition the diff touches is exhaustive and has no unhandled case",
        failureModes: [
          "a transition the switch/guard forgot",
          "an off-nominal ordering that skips a required step",
        ],
        evidenceStandard: "a table-driven test enumerating every transition the diff can produce",
        blockerClasses: ["wedged_state", "silent_success"],
      },
    },
  },
  [S_GIT_PUBLICATION]: {
    lenses: {
      backend: {
        invariant:
          "a git publication (worktree merge/push/branch move) is atomic and durable — it either fully lands or leaves the tree unchanged, never a half-published state",
        failureModes: [
          "a non-atomic publish that leaves refs half-moved on interruption",
          "a merge that silently drops or overwrites committed work (data loss)",
          "a worktree left dirty/locked so the next run wedges",
        ],
        evidenceStandard:
          "an integration or worktree-tier test exercising the interrupted/conflicting publish and asserting no lost commits",
        blockerClasses: ["data_loss", "non_atomic_state", "wedged_state"],
      },
      security: {
        invariant: "nothing published carries a secret or grants write beyond the intended ref",
        failureModes: [
          "a credential or token committed into the published tree",
          "a push scope wider than the reviewed branch",
        ],
        evidenceStandard: "a test asserting the published set contains no secret material and the ref scope is bounded",
        blockerClasses: ["credential_leakage", "data_loss"],
      },
    },
  },
  [S_AUTH_CREDENTIAL]: {
    lenses: {
      security: {
        invariant:
          "credentials and secrets never leak into logs, results, or durable state, and every trust gate is enforced on the write path",
        failureModes: [
          "a secret echoed into a log line, result.json, or an error message",
          "a trust gate checked on read but not on the write it protects",
          "a credential persisted unencrypted in durable state",
          "an auth check that fails open on a malformed token",
        ],
        evidenceStandard:
          "a negative-path test that supplies a bad/absent credential and asserts refusal, plus a scan asserting no secret reaches a durable sink",
        blockerClasses: ["credential_leakage", "silent_success"],
      },
    },
  },
  [S_ROUTING_POLICY]: {
    lenses: {
      backend: {
        invariant:
          "routing/RACI/model-policy resolution is derived from the compiled policy, not from memory, and a force rule cannot be weakened by an override",
        failureModes: [
          "a route resolved from a hardcoded default that bypasses the compiled policy",
          "a project override that weakens a host force rule",
          "a runtime/model selection that silently falls back off-policy",
        ],
        evidenceStandard: "a test asserting the resolved route matches the compiled policy for the changed keys",
        blockerClasses: ["silent_success"],
      },
      wide: {
        invariant: "the routing change does not shift accountability or open an unreviewed dispatch path across the system",
        failureModes: [
          "a new dispatch path that skips a required review gate",
          "a cross-cutting policy change whose blast radius exceeds the diff",
        ],
        evidenceStandard: "an architectural walk of every dispatch site the changed policy reaches",
        blockerClasses: ["silent_success"],
      },
    },
  },
  [S_DB_STATE]: {
    lenses: {
      backend: {
        invariant:
          "a schema/durable-state change migrates forward without data loss and is safe to replay; reads and writes agree on the shape at every step",
        failureModes: [
          "a migration that drops or truncates a column carrying live data",
          "a non-idempotent migration that corrupts on partial re-run",
          "a read path that assumes the new shape before the write path produces it",
        ],
        evidenceStandard:
          "an integration test that migrates a populated fixture forward and asserts no row/field is lost, replay-safe",
        blockerClasses: ["data_loss", "non_atomic_state"],
      },
    },
  },
  [S_TEST_INFRA]: {
    lenses: {
      backend: {
        invariant:
          "the test/validation infrastructure cannot report green for work it did not actually exercise — a skipped or short-circuited test is never counted as evidence",
        failureModes: [
          "a test that SKIPs yet is reported as passed",
          "a harness that swallows a failure and exits green",
          "a validation gate that can be satisfied without running",
        ],
        evidenceStandard:
          "a meta-test asserting the harness fails when its subject fails, and that a skipped case is not counted as passed",
        blockerClasses: ["fake_validation", "silent_success"],
      },
      wide: {
        invariant: "the validation change does not narrow what the suite proves across the codebase",
        failureModes: [
          "a change that quietly excludes a tier or a file set from the run",
          "a coverage claim broader than what the suite executes",
        ],
        evidenceStandard: "an accounting of what the suite ran before vs after, with any dropped coverage named",
        blockerClasses: ["fake_validation"],
      },
    },
  },
  [S_DONE_GATE]: {
    lenses: {
      backend: {
        invariant:
          "a done/acceptance gate advances only on real recorded evidence bound to the candidate sha — it can neither be satisfied by omission nor by a synthesized pass",
        failureModes: [
          "a gate that treats a missing result as a pass",
          "an acceptance check satisfied by a synthesized or stale outcome",
          "a wrong-ship: the gate advances work that does not meet its stated AC",
        ],
        evidenceStandard:
          "a test driving the gate with absent/failing evidence and asserting it refuses to advance",
        blockerClasses: ["fake_validation", "silent_success"],
      },
      wide: {
        invariant: "the gate change preserves the wrong-ship-prevention guarantee end to end",
        failureModes: ["a bypass path that reaches complete without the gate", "an authority boundary the change relaxes"],
        evidenceStandard: "a walk of every path that can reach the terminal complete state",
        blockerClasses: ["fake_validation", "silent_success"],
      },
    },
  },
  [S_DASHBOARD]: {
    lenses: {
      frontend: {
        invariant:
          "a dashboard decision surface shows the operator the TRUE state — what it displays is what the store holds, and 'not run' never renders as 'passed'",
        failureModes: [
          "a status that renders green for an absent/failed underlying state",
          "a stale or cached value presented as current",
          "an empty/error state rendered as a benign success",
        ],
        evidenceStandard:
          "a rendering test binding the surface to a failed/absent/empty store state and asserting it is shown as such, not as passed",
        blockerClasses: ["silent_success", "fake_validation"],
      },
      narrow: {
        invariant: "the specific decision the operator makes from this surface cannot be driven by a mislabeled value",
        failureModes: ["a label/threshold off by one that flips the operator's decision"],
        evidenceStandard: "a test asserting the surfaced decision matches the underlying data on the boundary case",
        blockerClasses: ["silent_success"],
      },
    },
  },
  [S_CROSS_MODULE]: {
    lenses: {
      wide: {
        invariant:
          "a broad cross-module contract change keeps every consumer in agreement — no caller is left reading the old shape or an unhandled new one",
        failureModes: [
          "a consumer not updated for the changed contract",
          "a blast radius wider than the diff, reaching modules the change did not touch",
          "a shared invariant one module now violates for another",
        ],
        evidenceStandard: "an accounting of every consumer of the changed contract and a test at each boundary",
        blockerClasses: ["silent_success", "non_atomic_state"],
      },
    },
  },
};

/** The advisory input. `changedPathClasses` carries the orchestrator's AUTHORED
 *  classification of the change (signal + the paths it applies to); `riskSignals` carries
 *  additional signals not tied to a specific path set. Neither is derived from a diff. */
export type ChangedPathClass = {
  signal: RiskSignal | string;
  paths: string[];
};

export type PlanRiskRedsInput = {
  route: string;
  changedPathClasses: ChangedPathClass[];
  acceptanceRefs: string[];
  protectedInvariants: string[];
  riskSignals: (RiskSignal | string)[];
  /** The red lens roles actually installed on this host. A SELECTED lens absent here is
   *  recorded `unavailable` — never silently treated as passed. Defaults to all five. */
  availableLenses?: RiskLens[];
};

export type PerLensSpec = {
  lens: RiskLens;
  invariant: string;
  failureModes: string[];
  paths: string[];
  evidenceStandard: string;
  blockerClasses: BlockerClass[];
};

export type RiskRedsPlan = {
  selectedLenses: RiskLens[];
  perLens: PerLensSpec[];
  skipped: { lens: RiskLens; reason: string }[];
  /** A SELECTED lens whose red role is not installed. Recorded so "not run" is never read
   *  as "passed" — a distinct state from `skipped` (deliberately not targeted). */
  unavailable: { lens: RiskLens; reason: string }[];
  reason: string;
};

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** FAIL-CLOSED WIDER: an unrecognized/ambiguous high-risk control-plane change selects
 *  wide + security, mirroring the no-contract fail-closed-wider at review-contract.ts:135. */
const FAIL_CLOSED_LENSES: RiskLens[] = ["wide", "security"];

export function planRiskReds(input: PlanRiskRedsInput): RiskRedsPlan {
  const available = new Set<RiskLens>(input.availableLenses ?? RISK_LENSES);

  // Gather the authored signals and the paths each one applies to. An unknown signal
  // string is NOT dropped — it is the ambiguity that trips the fail-closed arm below.
  const pathsBySignal = new Map<string, string[]>();
  const seen: string[] = [];
  const unrecognized: string[] = [];
  const record = (raw: string, paths: string[]) => {
    seen.push(raw);
    if (!isRiskSignal(raw)) {
      unrecognized.push(raw);
      return;
    }
    const existing = pathsBySignal.get(raw) ?? [];
    pathsBySignal.set(raw, [...existing, ...paths]);
  };
  for (const c of input.changedPathClasses) record(c.signal, c.paths);
  for (const s of input.riskSignals) record(s, []);

  const recognized = dedupe(seen.filter(isRiskSignal));
  const nonDocsRecognized = recognized.filter((s) => s !== S_DOCS_ONLY);

  // FAIL-CLOSED: any unrecognized signal is treated as an ambiguous high-risk control-plane
  // change and widens to wide+security. An empty input (nothing authored at all) is the same
  // ambiguity — nobody said this was safe, so it is not assumed safe.
  const ambiguous = unrecognized.length > 0 || seen.length === 0;
  if (ambiguous) {
    return finalize(
      FAIL_CLOSED_LENSES,
      collectSpecsForFailClosed(input, pathsBySignal),
      available,
      unrecognized.length > 0
        ? `fail-closed (wider): unrecognized/ambiguous risk signal(s) ${dedupe(unrecognized).join(", ")} on route ${input.route} — an unclassifiable high-risk control-plane change selects wide+security rather than guessing coverage`
        : `fail-closed (wider): no risk signals authored for route ${input.route} — an unclassified change is not assumed safe, so it selects wide+security`,
    );
  }

  // DOCS-ONLY low-risk: the only recognized signal is docs-only. Select none, WITH a reason.
  if (nonDocsRecognized.length === 0 && recognized.includes(S_DOCS_ONLY)) {
    return finalize(
      [],
      [],
      available,
      `mechanically low-risk docs-only change on route ${input.route}: no adversarial lens targeted (recorded none, not skipped-by-omission)`,
    );
  }

  // Recognized non-docs signals: union their lens selections and merge the attack specs.
  const specsByLens = new Map<RiskLens, PerLensSpec>();
  for (const signal of nonDocsRecognized) {
    const entry = RISK_REDS_TAXONOMY[signal as Exclude<RiskSignal, typeof S_DOCS_ONLY>];
    const signalPaths = pathsBySignal.get(signal) ?? [];
    for (const lens of Object.keys(entry.lenses) as RiskLens[]) {
      mergeSpec(specsByLens, lens, entry.lenses[lens]!, signalPaths);
    }
  }

  const selected = (RISK_LENSES as readonly RiskLens[]).filter((l) => specsByLens.has(l));
  return finalize(
    selected,
    selected.map((l) => specsByLens.get(l)!),
    available,
    `risk-targeted selection on route ${input.route}: signal(s) ${nonDocsRecognized.join(", ")} → lens(es) ${selected.join(", ")}`,
  );
}

function mergeSpec(
  byLens: Map<RiskLens, PerLensSpec>,
  lens: RiskLens,
  attack: LensAttack,
  paths: string[],
): void {
  const existing = byLens.get(lens);
  if (!existing) {
    byLens.set(lens, {
      lens,
      invariant: attack.invariant,
      failureModes: dedupe(attack.failureModes),
      paths: dedupe(paths),
      evidenceStandard: attack.evidenceStandard,
      blockerClasses: dedupe(attack.blockerClasses),
    });
    return;
  }
  existing.invariant = dedupe([existing.invariant, attack.invariant]).join("; ");
  existing.failureModes = dedupe([...existing.failureModes, ...attack.failureModes]);
  existing.paths = dedupe([...existing.paths, ...paths]);
  existing.evidenceStandard = dedupe([existing.evidenceStandard, attack.evidenceStandard]).join("; ");
  existing.blockerClasses = dedupe([...existing.blockerClasses, ...attack.blockerClasses]);
}

/** For a fail-closed plan the signals were unrecognized, so there is no taxonomy entry to
 *  read. wide+security still carry a stated invariant and the strongest evidence standard —
 *  the reviewer is pointed at the whole change, blocker-biased toward the worst outcomes. */
function collectSpecsForFailClosed(
  input: PlanRiskRedsInput,
  pathsBySignal: Map<string, string[]>,
): PerLensSpec[] {
  const allPaths = dedupe([
    ...input.changedPathClasses.flatMap((c) => c.paths),
    ...[...pathsBySignal.values()].flat(),
  ]);
  return [
    {
      lens: "wide",
      invariant:
        "an unclassifiable control-plane change violates no stated invariant" +
        (input.protectedInvariants.length > 0 ? `: ${input.protectedInvariants.join("; ")}` : ""),
      failureModes: [
        "a blast radius wider than the diff reaching an unreviewed surface",
        "a stated invariant silently weakened by the change",
      ],
      paths: allPaths,
      evidenceStandard:
        "an architectural walk of the whole change against every protected invariant and acceptance ref, with a test at each boundary it touches",
      blockerClasses: ["wedged_state", "non_atomic_state", "silent_success"],
    },
    {
      lens: "security",
      invariant: "the unclassifiable change opens no trust boundary and leaks no credential",
      failureModes: [
        "a trust gate the change bypasses on the write path",
        "a credential or secret the change exposes",
      ],
      paths: allPaths,
      evidenceStandard:
        "a negative-path test over every trust gate the change touches, plus a scan for secret material reaching a durable sink",
      blockerClasses: ["credential_leakage", "silent_success"],
    },
  ];
}

/** Partition all five lenses into selected / unavailable / skipped, so every lens is
 *  accounted for and "not run" can never be mistaken for "passed". A selected lens whose
 *  role is not installed drops to `unavailable`; every other unselected lens is `skipped`. */
function finalize(
  wanted: RiskLens[],
  specs: PerLensSpec[],
  available: Set<RiskLens>,
  reason: string,
): RiskRedsPlan {
  const selectedLenses: RiskLens[] = [];
  const perLens: PerLensSpec[] = [];
  const unavailable: { lens: RiskLens; reason: string }[] = [];
  for (const lens of wanted) {
    const spec = specs.find((s) => s.lens === lens)!;
    if (available.has(lens)) {
      selectedLenses.push(lens);
      perLens.push(spec);
    } else {
      unavailable.push({
        lens,
        reason: `${lensRole(lens)} was selected but its red role is not installed on this host — recorded unavailable, NOT passed; the selected surface was not reviewed`,
      });
    }
  }
  const accountedFor = new Set<RiskLens>(wanted);
  const skipped = (RISK_LENSES as readonly RiskLens[])
    .filter((l) => !accountedFor.has(l))
    .map((l) => ({ lens: l, reason: `no authored risk signal targets the ${l} lens for this change` }));
  return { selectedLenses, perLens, skipped, unavailable, reason };
}

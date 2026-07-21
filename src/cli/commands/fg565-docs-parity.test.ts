import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// FG-565 G5 (closeout): docs-parity for the two normative claims the gate says
// must be TESTED, not assumed —
//   (1) the completion-driven launch-wait policy, and
//   (2) the ScheduleWakeup-watchdog-only rule (BD-9).
//
// Divergence from the model test (orchestrator-block-parity.test.ts): the CLAUDE.md
// orchestrator block is machine-rendered from the seed, so that test can assert
// byte-for-byte parity through the real installer. The prose docs (quick-start.md,
// concepts.md) have NO generator — they agree by hand-authored prose — so byte- or
// line-parity would be meaningless. This test therefore extracts the invariant
// NORMATIVE CLAIMS and asserts every source expresses them, and that NO source
// carries the FG-542-era contradiction (ScheduleWakeup owning ordinary delays /
// being sized to a job's duration). It intentionally does not assert verbatim
// wording, and it does NOT reference docs/autonomous-run-prompt.md (which does not
// exist in the tree; the --require-control-toolchain prose it was meant to add
// already lives in quick-start.md / concepts.md).
//
// RED baseline (coverage hole, injection-based — same discipline as the fg571
// mutant arms): the parity itself is the assertion, so the RED demonstration is to
// mutate any source's normative claim (e.g. invert concepts.md's watchdog-only line
// to the FG-542-era "ScheduleWakeup owns ordinary delays", or delete the
// completion-driven wait claim from quick-start.md) and observe the matching claim
// go unsatisfied. A reviewer should NOT expect a production-code revert to redden
// this test — the defect it guards is drift between the prose docs and the seed.
//
// Pure string function over three real repo files — stays in the fast unit tier.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const SOURCES = {
  seed: resolve(repoRoot, "seeds", "orchestrator-template.md"),
  "quick-start": resolve(repoRoot, "docs", "quick-start.md"),
  concepts: resolve(repoRoot, "docs", "concepts.md"),
} as const;

// Whitespace-normalized, lowercased — so a claim survives reflow/wrapping and only
// a genuine wording/meaning change flips a predicate.
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

function loadNormalized(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, path] of Object.entries(SOURCES)) {
    out[name] = normalize(readFileSync(path, "utf8"));
  }
  return out;
}

// A normative claim is satisfied when EVERY predicate below holds for a source.
// Each predicate accepts a set of equivalent phrasings (claim-agreement, not
// verbatim prose) so the docs may express the invariant in their own words.
type Claim = {
  name: string;
  predicates: { label: string; anyOf: RegExp[] }[];
};

const CLAIMS: Claim[] = [
  {
    name: "ScheduleWakeup is a lost-signal watchdog only (BD-9), never a job-duration timer",
    predicates: [
      { label: "names ScheduleWakeup", anyOf: [/schedulewakeup/] },
      { label: "frames it as a watchdog", anyOf: [/watchdog/] },
      {
        label: "ties it to lost-signal recovery",
        anyOf: [/lost-signals?/, /lost completion/, /lost wake/],
      },
      {
        label: "denies job-duration sizing",
        anyOf: [
          /never sized from[^.]*duration/,
          /never a job-duration timer/,
          /not[^.]*sized from a job/,
        ],
      },
    ],
  },
  {
    name: "The launch-wait is completion-driven, not fixed-estimate polling",
    predicates: [
      {
        label: "names the completion-contract primitive (forge launch wait)",
        anyOf: [/forge launch wait/],
      },
      {
        label: "asserts completion-driven wake over a fixed estimate/poll",
        anyOf: [
          /completion-driven/,
          /rather than fixed-estimate polling/,
          /instead of polling on a fixed estimate/,
          /rather than a guessed wakeup or a fixed-interval poll/,
          /driven by the launch actually finishing/,
          /on (each|every) completion wake/,
          /the moment a launch finishes/,
        ],
      },
    ],
  },
];

// FG-542-era wrong policy — must appear in NO source. Anchored so the correct,
// negated statements ("never sized from a job's duration", "never a job-duration
// timer") can never trip it.
const CONTRADICTIONS: { label: string; pattern: RegExp }[] = [
  {
    label: "ScheduleWakeup owning ordinary/normal delays",
    pattern: /schedulewakeup[^.]{0,80}owns[^.]{0,40}(ordinary|normal) delay/,
  },
  {
    label: "ScheduleWakeup asserted to BE a duration timer",
    pattern: /schedulewakeup[^.]{0,40}\bis (a|the) (job-duration|duration) timer/,
  },
  {
    label: "sizing ScheduleWakeup to the job's duration",
    pattern: /size[^.]{0,20}schedulewakeup[^.]{0,30}to[^.]{0,20}(the job|its duration|how long)/,
  },
];

test("prose docs and the seed agree on the completion-driven launch-wait + ScheduleWakeup-watchdog-only claims", () => {
  const sources = loadNormalized();

  for (const claim of CLAIMS) {
    for (const [sourceName, text] of Object.entries(sources)) {
      for (const predicate of claim.predicates) {
        const satisfied = predicate.anyOf.some((re) => re.test(text));
        assert.ok(
          satisfied,
          `Docs parity broke: ${sourceName} no longer expresses "${claim.name}" ` +
            `— missing predicate: ${predicate.label}. Every one of ` +
            `${Object.keys(SOURCES).join(", ")} must state this claim (claim-agreement, ` +
            `not verbatim wording). Reconcile the diverged source against the others.`,
        );
      }
    }
  }
});

test("no source reintroduces the FG-542-era claim that ScheduleWakeup owns ordinary delays / is a duration timer", () => {
  const sources = loadNormalized();

  for (const [sourceName, text] of Object.entries(sources)) {
    for (const contradiction of CONTRADICTIONS) {
      assert.ok(
        !contradiction.pattern.test(text),
        `${sourceName} reintroduced a superseded policy claim: ${contradiction.label}. ` +
          `Per BD-9, ScheduleWakeup is a fixed health-bound lost-signal watchdog only, ` +
          `never sized from a job's duration — remove the offending statement.`,
      );
    }
  }
});

// FG-565 closeout (delivery-mode semantic): `forge lost-signals` is a RECOVERY
// ledger, not a DELIVERY ledger. G5 above checked the watchdog-only + completion-
// driven claims but NOT the delivery-mode semantic — so a surface could still
// reintroduce the overclaim that lost-signals durably records / distinguishes
// "normal delivery". It does not: only watchdog recoveries get a durable row, and
// normal delivery is inferred from the ABSENCE of a recovery row, never recorded
// per launch. This asserts every surface that describes `forge lost-signals`
// carries the honest framing AND none reintroduces the overclaim.
//
// Proof-by-construction (falsifiable): the pre-fix concepts.md clause — "renders
// that audit — which controller recovered which launch, and whether by watchdog or
// normal delivery" — matches DELIVERY_MODE_OVERCLAIMS and would redden this test.
const DELIVERY_MODE_FRAMING: { label: string; anyOf: RegExp[] }[] = [
  { label: "names forge lost-signals", anyOf: [/forge lost-signals/] },
  {
    label: "frames it as a recovery ledger, not a delivery ledger",
    anyOf: [
      /recovery ledger, not a delivery ledger/,
      /records? only[^.]*watchdog recover/,
    ],
  },
  {
    label: "says normal delivery is inferred from the absence of a row, not recorded per launch",
    anyOf: [/inferred from the absence of a[^.]{0,20}row/, /absence of a recovery row/],
  },
];

// The overclaim: presenting "watchdog vs normal delivery" as something lost-signals
// durably records/distinguishes per launch. Anchored to the specific phrasings so the
// honest, negated statements ("normal delivery ... not itself durably recorded per
// launch", "delivered normally from the absence of a row") can never trip it.
const DELIVERY_MODE_OVERCLAIMS: { label: string; pattern: RegExp }[] = [
  {
    label: 'presenting "whether by watchdog or normal delivery" as a durable per-launch record',
    pattern: /whether by (the )?watchdog or normal delivery/,
  },
  {
    label: 'presenting "watchdog vs delivered normally" as durably recorded',
    pattern: /(recovered )?by (the )?watchdog[^.]{0,30}vs\.?[^.]{0,30}delivered normally/,
  },
];

test("all three surfaces describe `forge lost-signals` as a recovery ledger, not a delivery ledger, with no normal-delivery overclaim", () => {
  const sources = loadNormalized();

  for (const [sourceName, text] of Object.entries(sources)) {
    for (const predicate of DELIVERY_MODE_FRAMING) {
      const satisfied = predicate.anyOf.some((re) => re.test(text));
      assert.ok(
        satisfied,
        `Lost-signals delivery-mode framing broke: ${sourceName} no longer expresses ` +
          `the honest "recovery ledger, not a delivery ledger" claim — missing predicate: ` +
          `${predicate.label}. Normal delivery is inferred from the ABSENCE of a recovery ` +
          `row, never durably recorded per launch; every surface describing forge ` +
          `lost-signals must say so (claim-agreement, not verbatim wording).`,
      );
    }
    for (const overclaim of DELIVERY_MODE_OVERCLAIMS) {
      assert.ok(
        !overclaim.pattern.test(text),
        `${sourceName} reintroduced the lost-signals delivery-mode overclaim: ` +
          `${overclaim.label}. forge lost-signals records ONLY watchdog recoveries; it ` +
          `does not durably distinguish or record normal delivery — remove the claim.`,
      );
    }
  }
});

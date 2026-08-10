// FG-700 — the operator-facing documents describe the DECLARED-PURPOSE rule, and no
// longer describe the shape it replaced.
//
// ─── WHY THIS TEST HAS TO EXIST ──────────────────────────────────────────────
// FG-700 narrowed what may be CALLED host verification and added a fourth section to
// the Current-activity payload. Nothing mechanical notices when a change like that
// leaves the operator documents describing the old behaviour: `dashboard/README.md`
// kept calling `/api/current-activity` a three-section projection and kept stating the
// Home wait rule in association-and-running terms alone, which is a document that
// tells an operator the association metadata still authorizes the label.
//
// ─── WHY IT IS NOT VACUOUS ───────────────────────────────────────────────────
// The vocabulary and the heading are DERIVED, not written down here: the purposes come
// from `LAUNCH_PURPOSE_VALUES` (the same object the decoder and the CLI validate
// against), and the `Launch activity` heading is scraped out of the two renderers that
// print it. So adding, removing or renaming a purpose — or renaming the section —
// reddens this test rather than silently outdating the prose. Both were demonstrated
// to fail before this was committed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_VERIFICATION_PURPOSE, LAUNCH_PURPOSE_VALUES } from "../../store/launch-observations.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/** The operator surfaces the purpose rule has to reach. Each is a distinct reader,
 *  not a copy of another:
 *    dashboard README — what the dashboard's own surfaces claim, and the HTTP shape.
 *    concepts         — the model (what purpose is, and why it is not association).
 *    schema contract  — the column, its vocabulary, and its fail-closed decode. */
const PURPOSE_SURFACES = ["dashboard/README.md", "docs/concepts.md", "docs/SCHEMA-CONTRACT.md"];

test("FG-700: every declared purpose is named on every operator surface", () => {
  const missing: string[] = [];
  for (const purpose of LAUNCH_PURPOSE_VALUES) {
    for (const surface of PURPOSE_SURFACES) {
      if (!new RegExp(`\\b${purpose}\\b`).test(read(surface))) missing.push(`${surface}: ${purpose}`);
    }
  }
  assert.deepEqual(missing, [], "a launch purpose an operator can declare is undocumented");
});

test("FG-700: `--purpose` is registered on `forge launch run` and documented as the submission surface", () => {
  // Scraped, so a rename of the flag cannot leave the docs "correct" by naming the old
  // one — the same rename hole fg609-docs-parity guards for the backlog verbs.
  const launchSrc = read("src/cli/commands/launch.ts");
  assert.match(launchSrc, /--purpose <\$\{LAUNCH_PURPOSE_VALUES\.join\("\|"\)\}>/, "`--purpose` is no longer registered as written");
  for (const surface of PURPOSE_SURFACES) {
    assert.match(read(surface), /--purpose/, `${surface} does not name the \`--purpose\` submission surface`);
  }
});

test("FG-700: the docs state that purpose, not association, authorizes the host-verification label", () => {
  const claims: [string, RegExp][] = [
    // The Home wait rule: it may not be stated in association-and-running terms alone.
    ["dashboard/README.md", new RegExp(`--purpose ${HOST_VERIFICATION_PURPOSE}[\\s\\S]{0,400}associated`)],
    ["docs/concepts.md", new RegExp(`--purpose ${HOST_VERIFICATION_PURPOSE}[\\s\\S]{0,400}associated`)],
    // The separation itself, and the fail-closed decode.
    ["docs/concepts.md", /Association answers \*where\*[\s\S]{0,200}purpose answers \*what it is\*/],
    ["docs/concepts.md", /fails closed to `generic`/],
    ["docs/SCHEMA-CONTRACT.md", /fail closed to `generic`/],
    ["docs/SCHEMA-CONTRACT.md", /ONLY value that may render/],
  ];
  for (const [file, pattern] of claims) {
    assert.match(read(file), pattern, `${file} is missing: ${pattern}`);
  }
});

test("FG-700: the `Launch activity` section is documented under the heading both renderers print", () => {
  // Derived from BOTH renderers, and they must agree with each other first — a heading
  // that drifts between `forge status` and the dashboard is the FG-679 agreement
  // failure this section would otherwise reintroduce.
  const cli = read("src/v2/current-activity.ts").match(/lines\.push\("\s+(Launch [a-z]+)"\)/);
  const client = read("dashboard/client/current-activity-render.js").match(/heading: "(Launch [a-z]+)"/);
  assert.ok(cli, "`forge status` no longer prints a `Launch …` heading");
  assert.ok(client, "the dashboard no longer renders a `Launch …` heading");
  assert.equal(cli![1], client![1], "the two surfaces print different headings for the same section");

  const heading = cli![1]!;
  for (const surface of ["dashboard/README.md", "docs/concepts.md"]) {
    assert.match(read(surface), new RegExp(`\\*\\*${heading}\\*\\*`), `${surface} does not document the \`${heading}\` section`);
  }
});

test("FG-700: no operator document still calls the Current activity projection three-section", () => {
  // The claim this change falsified, corrected in the same cycle that falsified it. A
  // stale "three-section" sends an integrator looking for a payload key set that is
  // one bucket short of what the endpoint returns.
  for (const surface of PURPOSE_SURFACES) {
    assert.equal(/three-section/.test(read(surface)), false, `${surface} still calls the projection three-section`);
  }
  for (const surface of ["dashboard/README.md", "docs/SCHEMA-CONTRACT.md"]) {
    assert.match(read(surface), /`launches`/, `${surface} does not document the \`launches\` bucket`);
  }
});

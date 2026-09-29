// FG-824: the status token map is the dashboard client's ONLY status vocabulary. Two guards:
// every member of every store vocabulary has a token (and a CSS rule), and no other client
// module spells a status class itself.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_STATUSES, TASK_STATUSES } from "@forge/types";
import { ATTENTION_ITEM_KINDS } from "./attention-inbox.js";
import { ORCHESTRATOR_PRESENTATIONS } from "./queries.js";
import { LAUNCH_STATES } from "../../src/v2/launch.js";
import { QUEUE_CLAIM_STATES } from "../../src/store/queue-claims.js";
import { renderShell } from "./shell.js";
import {
  TONES, badgeClass, runMapStatusClass, statusToken, toneAccentClass, vocabularyValues,
  type Vocabulary,
} from "../client/status-tokens.js";

const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client");
const css = renderShell();

const STORE_VOCABULARIES: Array<{ vocab: Vocabulary; source: string; members: readonly string[]; extra?: string[] }> = [
  { vocab: "task", source: "TASK_STATUSES (tasks.status)", members: TASK_STATUSES },
  { vocab: "run", source: "RUN_STATUSES (runs.status)", members: RUN_STATUSES },
  { vocab: "inbox", source: "ATTENTION_ITEM_KINDS", members: ATTENTION_ITEM_KINDS },
  // `unobserved` is the observation marker a stale launch reads as, not a stored outcome.
  { vocab: "launch", source: "LAUNCH_STATES (launch outcomes)", members: LAUNCH_STATES, extra: ["unobserved"] },
  { vocab: "claim", source: "QUEUE_CLAIM_STATES", members: QUEUE_CLAIM_STATES },
  { vocab: "receipt", source: "ORCHESTRATOR_PRESENTATIONS", members: ORCHESTRATOR_PRESENTATIONS },
];

function hasBadgeRule(cls: string): boolean {
  return new RegExp(`\\.badge\\.${cls}\\b[^{]*\\{[^}]*color:`).test(css) || new RegExp(`\\.badge\\.${cls}\\s*,`).test(css);
}

describe("FG-824: every store vocabulary member has a token", () => {
  for (const { vocab, source, members, extra = [] } of STORE_VOCABULARIES) {
    test(`${vocab}: every member of ${source} renders through its own token`, () => {
      for (const member of members) {
        const token = statusToken(vocab, member);
        assert.equal(token.known, true, `${source} member '${member}' has no token in client/status-tokens.js`);
        assert.ok(token.label.trim() !== "", `'${member}' has a blank label`);
        assert.ok((TONES as readonly string[]).includes(token.tone), `'${member}' has tone '${token.tone}'`);
        assert.ok(hasBadgeRule(token.class), `'${member}' → .badge.${token.class} has no colour rule in shell.ts`);
      }
    });

    test(`${vocab}: the token map carries nothing ${source} does not`, () => {
      assert.deepEqual(
        vocabularyValues(vocab).filter((v) => !members.includes(v) && !extra.includes(v)),
        [],
        "a token for a value the store no longer has is dead vocabulary",
      );
    });
  }

  test("the inbox kinds keep their operator labels, never the raw kind", () => {
    for (const kind of ATTENTION_ITEM_KINDS) assert.notEqual(statusToken("inbox", kind).label, kind);
    assert.equal(statusToken("inbox", "kanban_conflict").label, "Kanban conflict");
  });

  test("no launch outcome is painted as a generic failure (BD-4)", () => {
    for (const state of [...LAUNCH_STATES, "unobserved"]) {
      assert.doesNotMatch(statusToken("launch", state).class, /failed/);
    }
  });
});

describe("FG-824: an unknown value renders the neutral fallback", () => {
  for (const { vocab } of STORE_VOCABULARIES) {
    test(`${vocab}: an unknown value is neither blank nor a raw string alone`, () => {
      const token = statusToken(vocab, "brand_new_value");
      assert.equal(token.known, false);
      assert.equal(token.tone, "neutral");
      assert.equal(token.label, "brand_new_value (unrecognized)");
      assert.ok(hasBadgeRule(token.class), `fallback .badge.${token.class} has no rule`);
      for (const empty of [undefined, null, "", 42]) {
        const blank = statusToken(vocab, empty);
        assert.equal(blank.label, "unknown");
        assert.equal(blank.class, token.class);
      }
    });
  }

  test("a key inherited from Object.prototype is not a status", () => {
    assert.equal(statusToken("task", "constructor").known, false);
    assert.equal(statusToken("task", "__proto__").label, "__proto__ (unrecognized)");
  });

  test("badgeClass, runMapStatusClass and toneAccentClass render through the same map", () => {
    assert.equal(badgeClass("task", "awaiting_recovery"), "badge status-awaiting_recovery");
    assert.equal(badgeClass("run", "active"), "badge run-status-active");
    assert.equal(badgeClass("task", "nope"), "badge status-unknown");
    assert.equal(runMapStatusClass("failed"), "rm-status rm-status-failed");
    assert.equal(runMapStatusClass("nope"), "rm-status rm-status-unknown");
    assert.equal(toneAccentClass("err"), "tone-accent-err");
    assert.equal(toneAccentClass("purple"), "tone-accent-neutral");
    for (const tone of TONES) assert.match(css, new RegExp(`\\.tone-accent-${tone} \\{`));
    for (const s of TASK_STATUSES) assert.match(css, new RegExp(`\\.rm-status-${s}\\b`), `run map has no colour for ${s}`);
  });
});

// A status-class literal: one of the token families followed by a value, an interpolation or
// the end of a concatenated string. `--status-*` CSS variables, `cp-status-*`/`plan-status-*`
// /`rx-status-*` (other, non-store vocabularies) are excluded by the lookbehind.
const STATUS_CLASS_LITERAL = /(?<![\w-])(?:status|run-status|inbox-kind|launch-state|claim-state|rm-status|tone-accent)-(?:[a-z_]|\$\{|["'`])/;
const TOKEN_MODULE = "status-tokens.js";

function statusClassLiterals(file: string, source: string): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    const scrubbed = line.replace(/\.\/status-tokens\.js/g, "").replace(/\bstatus-dot\b/g, "");
    if (STATUS_CLASS_LITERAL.test(scrubbed)) hits.push(`${file}:${i + 1}: ${code}`);
  });
  return hits;
}

describe("FG-824: no client module spells a status class outside the token map", () => {
  test("the scan catches the shapes it exists for", () => {
    assert.equal(statusClassLiterals("x.js", 'const c = "status-failed";').length, 1);
    assert.equal(statusClassLiterals("x.js", "html`<span class=\"badge status-${s}\">`").length, 1);
    assert.equal(statusClassLiterals("x.js", 'const c = "badge status-" + s;').length, 1);
    assert.equal(statusClassLiterals("x.js", 'return "launch-state-unknown";').length, 1);
    assert.equal(statusClassLiterals("x.js", 'const k = { a: "inbox-kind-a" };').length, 1);
    assert.equal(statusClassLiterals("x.js", 'import { x } from "./status-tokens.js";').length, 0);
    assert.equal(statusClassLiterals("x.js", 'style="border-left: 3px solid var(--status-failed)"').length, 0);
    assert.equal(statusClassLiterals("x.js", 'cls: "cp-status-active"').length, 0);
    assert.equal(statusClassLiterals("x.js", "  // the status-failed badge").length, 0);
  });

  test("every client module other than status-tokens.js renders status classes through it", () => {
    const hits = readdirSync(CLIENT_DIR)
      .filter((f) => f.endsWith(".js") && f !== TOKEN_MODULE)
      .flatMap((f) => statusClassLiterals(f, readFileSync(join(CLIENT_DIR, f), "utf8")));
    assert.deepEqual(hits, [], "route these through client/status-tokens.js");
  });
});

// FG-402 / RF-4: the attention-inbox ITEM schema is documented in the stable external
// contract (docs/SCHEMA-CONTRACT.md), not only the envelope. A non-dashboard consumer
// (Stream Deck, forge status) must be able to build against a defined item shape.
//
// This is not vacuous: the `kind` vocabulary the doc must list is SCRAPED from the
// AttentionItemKind union in attention-inbox.ts, so adding or renaming a kind without
// documenting it fails this test — a hardcoded list would keep passing through a rename.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/** The kinds the closed vocabulary carries, scraped from the union declaration in the
 *  source so the doc check tracks the source rather than a copy that can drift. */
function attentionItemKinds(): string[] {
  const src = read("dashboard/src/attention-inbox.ts");
  const block = src.match(/export type AttentionItemKind =\s*([\s\S]*?);/);
  assert.ok(block, "AttentionItemKind union must be present in attention-inbox.ts");
  return [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** How many independently-read sources attentionInbox() actually composes, scraped from
 *  its composeInbox([...]) call so the documented count tracks the source rather than a
 *  copy that drifts (the exact RF-4 defect: the doc said three after a fourth was added). */
function composedSourceCount(): number {
  const src = read("dashboard/src/queries.ts");
  const call = src.match(/return composeInbox\(\[([\s\S]*?)\],/);
  assert.ok(call, "attentionInbox must compose its sources via composeInbox([...])");
  return call![1]!.split(",").map((s) => s.trim()).filter(Boolean).length;
}

const COUNT_WORDS: Record<number, string> = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };

describe("RF-4: SCHEMA-CONTRACT documents the InboxItem schema, not only the envelope", () => {
  const contract = read("docs/SCHEMA-CONTRACT.md");

  test("the item schema section exists and names InboxItem", () => {
    assert.match(contract, /response shape \(`InboxEnvelope` \/ `InboxItem`\)/);
    assert.match(contract, /Each `InboxItem`:/);
  });

  test("every required operator-context field is documented", () => {
    for (const field of ["id", "kind", "reason", "requestedAction", "source", "severity", "startedAt", "openState", "links"]) {
      assert.match(contract, new RegExp(`\`${field}\``), `InboxItem field \`${field}\` is undocumented in SCHEMA-CONTRACT.md`);
    }
  });

  test("the CLOSED kind vocabulary is documented in full, tracked to the source union", () => {
    const kinds = attentionItemKinds();
    assert.ok(kinds.length >= 7, "expected the full AttentionItemKind vocabulary to be scraped");
    for (const kind of kinds) {
      assert.match(contract, new RegExp(`\`${kind}\``), `inbox kind \`${kind}\` is undocumented in SCHEMA-CONTRACT.md`);
    }
  });

  test("RF-4: the documented source count matches attentionInbox's composed sources", () => {
    const n = composedSourceCount();
    const word = COUNT_WORDS[n];
    assert.ok(word, `unexpected composed-source count ${n} — extend COUNT_WORDS`);
    assert.match(
      contract,
      new RegExp(`Composes ${word} independently-read sources`),
      `SCHEMA-CONTRACT.md must say "Composes ${word} independently-read sources" — attentionInbox composes ${n} (FG-746 added the stale-verification source)`,
    );
  });

  test("RF-4: the stale-verification source is enumerated in the inbox composition", () => {
    assert.match(
      contract,
      /stale-verification items \(FG-746/,
      "the FG-746 stale-verification source must be enumerated alongside the other inbox sources, not only listed as a kind",
    );
  });
});

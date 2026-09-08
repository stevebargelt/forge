// FG-785 (external kanban projection, OUTBOUND-ONLY) — the attention-inbox source for
// external-board CONFLICTS. Unit tier: the mapper under test is PURE (it takes plain
// KanbanConflict objects), so these tests spawn no process and touch no real DB.
//
// What this proves (AC5 / step 5 acceptance):
//   - an OPEN conflict row projects to exactly one `kanban_conflict` attention item with
//     the right severity and both-version context;
//   - resolution is NOT an inbox concern: the mapper only ever receives open rows, so an
//     empty input (a resolved row that stopped being returned) yields no item — the inbox
//     stores no resolution flag of its own;
//   - the new kind participates in composeInbox dedup/precedence;
//   - untrusted external free text is redacted before it enters the operator-facing text.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { kanbanConflictsToAttentionItems } from "./queries.js";
import { composeInbox, kindPrecedence, dedupeAttentionItems, type AttentionItem } from "./attention-inbox.js";
import type { KanbanConflict } from "@forge/kanban-projection";

/** A fully-specified OPEN conflict fixture; override any field per test. */
function conflict(over: Partial<KanbanConflict> = {}): KanbanConflict {
  return {
    id: "cf-001",
    projectIdentity: "proj-key-abc",
    ticketIdentity: "FG-900",
    provider: "fake",
    externalCardId: "card-42",
    kind: "moved",
    forgeVersion: { column: "In Progress", title: "Do the thing" },
    externalVersion: { column: "Done", title: "Do the thing" },
    state: "open",
    detectedBy: "kanban-sync",
    detectedAt: "2026-09-08T12:00:00.000Z",
    createdAt: "2026-09-08T12:00:00.000Z",
    resolvedBy: null,
    resolvedAt: null,
    resolution: null,
    ...over,
  };
}

describe("FG-785: open kanban conflicts project into the attention inbox", () => {
  test("one open conflict → exactly one kanban_conflict item with both-version context and opaque links", () => {
    const items = kanbanConflictsToAttentionItems([conflict()]);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.kind, "kanban_conflict");
    assert.equal(item.id, "kanban_conflict:cf-001");
    assert.equal(item.openState, "open");
    assert.equal(item.source, "kanban_conflict");
    // Detection time drives the age string — never fabricated from "now".
    assert.equal(item.startedAt, "2026-09-08T12:00:00.000Z");

    // Both versions are carried in the operator-facing reason.
    assert.match(item.reason, /In Progress/);
    assert.match(item.reason, /Done/);
    assert.match(item.reason, /diverged/);
    // The change was NOT applied to Forge — the reason says so.
    assert.match(item.reason, /NOT applied/i);
    // The action points at the authorized host-operator resolution CLI, id intact.
    assert.match(item.requestedAction, /forge kanban conflicts-resolve cf-001/);
    assert.match(item.requestedAction, /no inbound planning change/i);

    // Opaque identity only (AC1): the ticket + project-key label, no provider concept,
    // no run/task/campaign/filesystem link.
    assert.equal(item.links.ticketId, "FG-900");
    assert.equal(item.links.projectLabel, "proj-key-abc");
    assert.equal(item.links.itemId, "cf-001");
    assert.equal(item.links.runId, null);
    assert.equal(item.links.taskId, null);
    assert.equal(item.links.campaignId, null);
    assert.equal(item.links.projectDir, null);
  });

  test("severity: an externally DELETED card is high, a move/edit is medium", () => {
    const [del] = kanbanConflictsToAttentionItems([conflict({ id: "d", kind: "deleted" })]);
    const [mov] = kanbanConflictsToAttentionItems([conflict({ id: "m", kind: "moved" })]);
    const [edt] = kanbanConflictsToAttentionItems([conflict({ id: "e", kind: "edited" })]);
    assert.equal(del!.severity, "high");
    assert.equal(mov!.severity, "medium");
    assert.equal(edt!.severity, "medium");
  });

  test("no stored resolution flag: the mapper only receives open rows, so an empty input yields no item", () => {
    // A resolved conflict simply stops being returned by listOpenConflicts, so the inbox
    // never has to carry resolution state — the source-derived, open-only invariant.
    assert.deepEqual(kanbanConflictsToAttentionItems([]), []);
  });

  test("untrusted external free text is redacted before it enters the item", () => {
    const secret = "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123456789";
    const leakyPath = "/home/operator/.forge/creds/board.json";
    const [item] = kanbanConflictsToAttentionItems([
      conflict({
        externalVersion: { title: `moved by ${secret}`, note: leakyPath },
      }),
    ]);
    assert.doesNotMatch(item!.reason, /ghp_ABCDEFGHIJKLMNOPQRSTUVWX/);
    assert.doesNotMatch(item!.reason, /\/home\/operator\/\.forge/);
    assert.match(item!.reason, /\[redacted\]/);
  });

  test("RF-3: a credential-shaped token straddling the 240-char clamp cutoff leaks no fragment", () => {
    // The both-versions digest is CLAMPED to 240 chars for the inbox. Redaction must run on the
    // FULL text first: if the clamp ran before the redactor, a credential token positioned across
    // the cutoff would be sliced to a prefix too short for the redactor's shape, and that prefix
    // would ride into the browser-facing reason. Position exactly that case and prove no fragment
    // survives. `note ` filler (word chars separated by spaces) never forms a redactable run itself.
    const token = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3"; // 40 chars, letters+digits, no known prefix
    const filler = "x ".repeat(115); // 230 chars, ends with a space → the token begins across the 240 cutoff
    const external = `${filler}${token}`;
    const [item] = kanbanConflictsToAttentionItems([conflict({ externalVersion: external })]);

    // Not even a short prefix of the token reaches the operator-facing reason (the old clamp-first
    // path leaked the ~10-char slice that fit before the cutoff).
    assert.doesNotMatch(item!.reason, /Aa1Bb2Cc3D/);
    assert.doesNotMatch(item!.reason, /Aa1Bb2/);
    assert.match(item!.reason, /\[redacted\]/);
  });

  test("distinct conflicts stay distinct rows (no runId to collapse on)", () => {
    const items = kanbanConflictsToAttentionItems([
      conflict({ id: "a", ticketIdentity: "FG-1" }),
      conflict({ id: "b", ticketIdentity: "FG-2" }),
    ]);
    const deduped = dedupeAttentionItems(items);
    assert.equal(deduped.length, 2);
  });

  test("the new kind participates in composeInbox precedence: known, and ranked below hard blocks", () => {
    // A known kind resolves to a real index, ahead of the forward-tolerant last slot an
    // unknown kind falls into.
    assert.ok(kindPrecedence("kanban_conflict") < kindPrecedence("a_totally_unknown_kind" as never));
    assert.ok(kindPrecedence("kanban_conflict") < kindPrecedence("waiting_gate"));
    assert.ok(kindPrecedence("kanban_conflict") > kindPrecedence("blocked_by_red_or_reviewer"));

    // It flows through the ONE assembly point cleanly.
    const env = composeInbox([kanbanConflictsToAttentionItems([conflict()])], {
      generatedAt: "2026-09-08T12:00:00.000Z",
      scope: { runId: null, projectDirs: null },
    });
    assert.equal(env.items.length, 1);
    assert.equal(env.items[0]!.kind, "kanban_conflict");
    assert.equal(env.empty, false);
  });

  test("a null/absent both-versions payload degrades gracefully to 'none'", () => {
    const [item] = kanbanConflictsToAttentionItems([
      conflict({ forgeVersion: null, externalVersion: undefined }),
    ]);
    assert.match(item!.reason, /Forge version: none/);
    assert.match(item!.reason, /External version: none/);
  });
});

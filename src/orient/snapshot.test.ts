// FG-588 — the compact orientation snapshot's bounds are a contract, tested on the
// pure projection so no store is needed. Empty, normal, over-limit, stale/closed/
// missing refs, mixed-severity ops, read-only, and the byte-budget regression.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Incident, IncidentKind, IncidentSeverity } from "../types/index.js";
import {
  ACTIVE_TICKET_IDS_CAP,
  HANDOFF_FIELD_MAX_CHARS,
  OPS_HIGHEST_CAP,
  ORIENT_SNAPSHOT_SCHEMA,
  ORIENT_SNAPSHOT_VERSION,
  REFERENCED_TICKET_TITLE_MAX_CHARS,
  REFERENCED_TICKETS_CAP,
  extractHandoffField,
  extractTicketRefs,
  projectOrientSnapshot,
  resolveTicketRef,
  type OrientResolvedTicket,
  type OrientSnapshotInputs,
} from "./snapshot.js";

function incident(severity: IncidentSeverity, kind: IncidentKind, runId: string, taskId: string | null): Incident {
  return {
    kind,
    severity,
    confidence: "db-confirmed",
    runId,
    taskId,
    // Deliberately verbose — the projection must DROP these, not carry them.
    evidence: [`EVIDENCE_MARKER for ${runId}: a long human-readable justification `.repeat(4)],
    recommendedAction: {
      type: "investigate",
      autonomy: "ask",
      command: null,
      reason: `RECOMMENDED_ACTION_MARKER for ${runId}: a long remediation instruction `.repeat(4),
    },
  };
}

const NEVER_RESOLVED: OrientSnapshotInputs["resolveTicket"] = (id) => {
  throw new Error(`resolveTicket unexpectedly called for ${id}`);
};

function baseInputs(over: Partial<OrientSnapshotInputs> = {}): OrientSnapshotInputs {
  return {
    project: { key: "forge", name: "Forge", path: "/code/forge", lastActivity: null, liveSessions: 0, inFlight: 0 },
    notesText: null,
    activeIds: [],
    resolveTicket: NEVER_RESOLVED,
    incidents: [],
    prefix: "FG",
    ...over,
  };
}

test("empty state: no notes, no tickets, no incidents — everything absent, nothing truncated", () => {
  const s = projectOrientSnapshot(baseInputs());
  assert.equal(s.schema, ORIENT_SNAPSHOT_SCHEMA);
  assert.equal(s.version, ORIENT_SNAPSHOT_VERSION);
  assert.equal(s.handoff.present, false);
  assert.equal(s.handoff.whereWeLeftOff, null);
  assert.equal(s.handoff.pickedUpNext, null);
  assert.equal(s.handoff.stale, false);
  assert.deepEqual(s.activeTickets, { count: 0, ids: [], truncated: false });
  assert.deepEqual(s.referencedTickets, { count: 0, refs: [], truncated: false });
  assert.deepEqual(s.ops, { total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, highestSeverity: [], truncated: false });
});

test("normal state: bounded handoff fields, active ids sorted by sticky desc, refs resolved", () => {
  const notes = [
    "**Last session ended 2026-08-20.**",
    "",
    "**Where we left off:** wiring the snapshot command.",
    "",
    "**Picked up next:** finish FG-588, then look at FG-600.",
    "",
    "**Shipped (for reference):** FG-587 the thing.",
  ].join("\n");
  const resolved: Record<string, OrientResolvedTicket> = {
    "FG-588": { id: "FG-588", status: "active", title: "Bound /orient context cost" },
    "FG-600": { id: "FG-600", status: "active", title: "Something else" },
  };
  const s = projectOrientSnapshot(
    baseInputs({
      notesText: notes,
      activeIds: ["FG-588", "FG-600", "FG-587"],
      resolveTicket: (id) => resolved[id] ?? { id, status: "missing", title: null },
    }),
  );
  assert.equal(s.handoff.present, true);
  assert.equal(s.handoff.whereWeLeftOff?.text, "wiring the snapshot command.");
  assert.equal(s.handoff.pickedUpNext?.text, "finish FG-588, then look at FG-600.");
  assert.equal(s.handoff.stale, false);
  assert.deepEqual(s.activeTickets.ids, ["FG-600", "FG-588", "FG-587"]);
  assert.deepEqual(
    s.referencedTickets.refs.map((r) => r.id),
    ["FG-588", "FG-600"],
    "only Picked-up-next refs are resolved, not Shipped",
  );
  assert.equal(s.referencedTickets.refs[0]?.status, "active");
});

test("stale handoff: present notes but no Picked up next section", () => {
  const s = projectOrientSnapshot(
    baseInputs({ notesText: "**Where we left off:** mid-refactor, nothing queued.", resolveTicket: (id) => ({ id, status: "missing", title: null }) }),
  );
  assert.equal(s.handoff.present, true);
  assert.equal(s.handoff.pickedUpNext, null);
  assert.equal(s.handoff.stale, true);
  assert.deepEqual(s.referencedTickets, { count: 0, refs: [], truncated: false });
});

test("closed and missing refs are distinguished — a done ticket of any age is not 'missing'", () => {
  const resolved: Record<string, OrientResolvedTicket> = {
    "FG-10": { id: "FG-10", status: "done", title: "Long-closed work" },
    "FG-999": { id: "FG-999", status: "missing", title: null },
  };
  const s = projectOrientSnapshot(
    baseInputs({
      notesText: "**Picked up next:** resume FG-10 and #999.",
      resolveTicket: (id) => resolved[id] ?? { id, status: "missing", title: null },
    }),
  );
  const byId = new Map(s.referencedTickets.refs.map((r) => [r.id, r]));
  assert.equal(byId.get("FG-10")?.status, "done", "a closed ticket resolves as done, never missing");
  assert.equal(byId.get("FG-999")?.status, "missing");
});

test("RF-1: an existing-but-unreadable ticket resolves as 'unreadable', never 'missing'", () => {
  // Exists but the read fails — the read-failure-after-existence-check case that was
  // being misreported as an absent ticket.
  const unreadable = resolveTicketRef(
    "FG-1",
    () => true,
    () => {
      throw new Error("read failed");
    },
  );
  assert.equal(unreadable.status, "unreadable");
  assert.notEqual(unreadable.status, "missing");

  // Existence itself indeterminable — still an error state, not 'missing'.
  const existenceThrew = resolveTicketRef(
    "FG-2",
    () => {
      throw new Error("existence check failed");
    },
    () => ({ status: "active", title: "x" }),
  );
  assert.equal(existenceThrew.status, "unreadable");

  // An actually-absent ticket is the ONLY 'missing'.
  const absent = resolveTicketRef("FG-3", () => false, () => ({ status: "active", title: "x" }));
  assert.equal(absent.status, "missing");

  // A readable ticket carries its real status/title.
  const ok = resolveTicketRef("FG-4", () => true, () => ({ status: "done", title: "t" }));
  assert.equal(ok.status, "done");
  assert.equal(ok.title, "t");
});

test("RF-1: an unreadable referenced ticket propagates through the projection as unreadable", () => {
  const s = projectOrientSnapshot(
    baseInputs({
      notesText: "**Picked up next:** resume FG-7.",
      resolveTicket: (id) => ({ id, status: "unreadable", title: null }),
    }),
  );
  assert.equal(s.referencedTickets.refs[0]?.status, "unreadable");
  assert.notEqual(s.referencedTickets.refs[0]?.status, "missing");
});

test("RF-2: a very long referenced title is truncated with metadata and the snapshot stays ≤5KB", () => {
  const longTitle = "T".repeat(6000);
  const s = projectOrientSnapshot(
    baseInputs({
      notesText: "**Picked up next:** finish FG-1.",
      resolveTicket: (id) => ({ id, status: "active", title: longTitle }),
    }),
  );
  const ref = s.referencedTickets.refs[0]!;
  assert.equal(ref.titleTruncated, true, "an over-limit title must be flagged truncated");
  assert.equal(ref.title?.length, REFERENCED_TICKET_TITLE_MAX_CHARS, "title is cut to the cap");
  assert.equal(ref.titleFullLength, 6000, "the untruncated length is preserved as metadata");
  const json = JSON.stringify(s);
  assert.ok(json.length <= 5 * 1024, `snapshot is ${json.length} bytes, over the 5 KB budget`);
});

test("RF-2: a title at or under the cap is carried whole with no truncation flag", () => {
  const title = "T".repeat(REFERENCED_TICKET_TITLE_MAX_CHARS);
  const s = projectOrientSnapshot(
    baseInputs({
      notesText: "**Picked up next:** finish FG-1.",
      resolveTicket: (id) => ({ id, status: "active", title }),
    }),
  );
  const ref = s.referencedTickets.refs[0]!;
  assert.equal(ref.titleTruncated, false);
  assert.equal(ref.title, title);
  assert.equal(ref.titleFullLength, REFERENCED_TICKET_TITLE_MAX_CHARS);
});

test("RF-3: a Picked-up-next referencing MANY tickets caps the collection with count/truncated metadata, snapshot stays ≤5KB", () => {
  // Many valid refs, each resolving to a title AT the per-title cap — the RF-2 fix
  // bounds each title but not the count, so without a collection cap the aggregate
  // blows the 5 KB budget silently. Build a Picked-up-next that names far more refs
  // than the cap.
  const refCount = REFERENCED_TICKETS_CAP + 200;
  const refIds = Array.from({ length: refCount }, (_, i) => `FG-${i + 1}`);
  const atCapTitle = "T".repeat(REFERENCED_TICKET_TITLE_MAX_CHARS);
  const bigField = "x".repeat(HANDOFF_FIELD_MAX_CHARS + 400);
  // Every OTHER bounded field maxed too — all three handoff fields over their cap, the
  // active-id set at its cap, ops over theirs — so the ≤5KB assertion guards the whole
  // snapshot's worst case, not the referenced collection in isolation.
  const notes = [
    `**Where we left off:** ${bigField}`,
    `**Picked up next:** ${refIds.join(", ")}. ${bigField}`,
    `**Memories this session may have invalidated:** ${bigField}`,
  ].join("\n\n");
  const s = projectOrientSnapshot(
    baseInputs({
      notesText: notes,
      activeIds: Array.from({ length: ACTIVE_TICKET_IDS_CAP + 50 }, (_, i) => `FG-${i + 1000}`),
      incidents: Array.from({ length: OPS_HIGHEST_CAP + 8 }, (_, i) =>
        incident("high", "reconcile_candidate", `run-${i}`, `task-${i}`),
      ),
      resolveTicket: (id) => ({ id, status: "active", title: atCapTitle }),
    }),
  );

  assert.equal(s.referencedTickets.count, refCount, "count reflects EVERY ref found, before the cap");
  assert.equal(s.referencedTickets.refs.length, REFERENCED_TICKETS_CAP, "the emitted collection is capped");
  assert.equal(s.referencedTickets.truncated, true, "a cut collection is flagged truncated — never silent");
  // Every emitted ref still carries its (at-cap) title with the per-title contract intact.
  for (const ref of s.referencedTickets.refs) {
    assert.equal(ref.title?.length, REFERENCED_TICKET_TITLE_MAX_CHARS);
    assert.equal(ref.titleTruncated, false);
  }
  const json = JSON.stringify(s);
  assert.ok(json.length <= 5 * 1024, `snapshot is ${json.length} bytes, over the 5 KB budget`);
});

test("RF-3: a Picked-up-next referencing at-most-cap tickets is carried whole with no collection truncation", () => {
  const refIds = Array.from({ length: REFERENCED_TICKETS_CAP }, (_, i) => `FG-${i + 1}`);
  const s = projectOrientSnapshot(
    baseInputs({
      notesText: `**Picked up next:** ${refIds.join(", ")}.`,
      resolveTicket: (id) => ({ id, status: "active", title: "short" }),
    }),
  );
  assert.equal(s.referencedTickets.count, REFERENCED_TICKETS_CAP);
  assert.equal(s.referencedTickets.refs.length, REFERENCED_TICKETS_CAP);
  assert.equal(s.referencedTickets.truncated, false);
});

test("over-limit: active ids capped with truncation, handoff fields truncated with fullLength, ops bounded", () => {
  const activeIds = Array.from({ length: ACTIVE_TICKET_IDS_CAP + 25 }, (_, i) => `FG-${i + 1}`);
  const longField = "x".repeat(HANDOFF_FIELD_MAX_CHARS + 400);
  const notes = `**Where we left off:** ${longField}\n\n**Picked up next:** ${longField}`;
  const incidents = Array.from({ length: OPS_HIGHEST_CAP + 8 }, (_, i) => incident("medium", "reconcile_candidate", `run-${i}`, `task-${i}`));
  const s = projectOrientSnapshot(
    baseInputs({ notesText: notes, activeIds, incidents, resolveTicket: (id) => ({ id, status: "missing", title: null }) }),
  );

  assert.equal(s.activeTickets.count, ACTIVE_TICKET_IDS_CAP + 25);
  assert.equal(s.activeTickets.ids.length, ACTIVE_TICKET_IDS_CAP);
  assert.equal(s.activeTickets.truncated, true);

  assert.equal(s.handoff.whereWeLeftOff?.truncated, true);
  assert.equal(s.handoff.whereWeLeftOff?.text.length, HANDOFF_FIELD_MAX_CHARS);
  assert.equal(s.handoff.whereWeLeftOff?.fullLength, HANDOFF_FIELD_MAX_CHARS + 400);

  assert.equal(s.ops.total, OPS_HIGHEST_CAP + 8);
  assert.equal(s.ops.highestSeverity.length, OPS_HIGHEST_CAP);
  assert.equal(s.ops.truncated, true);
});

test("mixed severity: highest-severity identities lead, counts by severity are exact", () => {
  const incidents = [
    incident("low", "container_reap_failed", "r1", "t1"),
    incident("high", "retry_orphan", "r2", "t2"),
    incident("medium", "reconcile_candidate", "r3", "t3"),
    incident("high", "stuck_run", "r4", null),
  ];
  const s = projectOrientSnapshot(baseInputs({ incidents }));
  assert.deepEqual(s.ops.bySeverity, { high: 2, medium: 1, low: 1 });
  assert.equal(s.ops.highestSeverity[0]?.severity, "high");
  assert.equal(s.ops.highestSeverity[1]?.severity, "high");
  // A stuck_run carries no taskId — the identity set must tolerate null.
  assert.ok(s.ops.highestSeverity.some((i) => i.taskId === null));
  // The bounded projection carries identity ONLY — never evidence or action prose.
  for (const i of s.ops.highestSeverity) {
    assert.deepEqual(Object.keys(i).sort(), ["kind", "runId", "severity", "taskId"]);
  }
});

test("read-only: the projection mutates none of its inputs", () => {
  const activeIds = ["FG-3", "FG-1", "FG-2"];
  const incidents = [incident("high", "retry_orphan", "r1", "t1")];
  const inputs = baseInputs({ notesText: "**Picked up next:** FG-1", activeIds, incidents, resolveTicket: (id) => ({ id, status: "active", title: "t" }) });
  const activeBefore = [...activeIds];
  const incidentsBefore = JSON.stringify(incidents);
  projectOrientSnapshot(inputs);
  assert.deepEqual(activeIds, activeBefore, "activeIds was reordered in place");
  assert.equal(JSON.stringify(incidents), incidentsBefore, "incidents were mutated");
});

test("byte-budget regression: a 100-active / 20-incident / normal-handoff snapshot stays ≤5KB and carries no bulk", () => {
  const activeIds = Array.from({ length: 100 }, (_, i) => `FG-${i + 1}`);
  const incidents = Array.from({ length: 20 }, (_, i) =>
    incident(i % 3 === 0 ? "high" : i % 3 === 1 ? "medium" : "low", "reconcile_candidate", `run-${i}`, `task-${i}`),
  );
  const notes = [
    "**Last session ended 2026-08-20.**",
    "",
    "**Where we left off:** finished the snapshot builder; tests green on the unit tier.",
    "",
    "**Picked up next:** wire the regression test, then confirm the render size. See FG-588.",
    "",
    "**Shipped (for reference):** FG-587, FG-586.",
  ].join("\n");
  const s = projectOrientSnapshot(
    baseInputs({
      notesText: notes,
      activeIds,
      incidents,
      resolveTicket: (id) => ({ id, status: "active", title: "UNIQUE_ACTIVE_TITLE_SHOULD_NOT_APPEAR" }),
    }),
  );
  const json = JSON.stringify(s);
  assert.ok(json.length <= 5 * 1024, `snapshot is ${json.length} bytes, over the 5 KB budget`);
  assert.ok(!json.includes("EVIDENCE_MARKER"), "incident evidence leaked into the ordinary snapshot");
  assert.ok(!json.includes("RECOMMENDED_ACTION_MARKER"), "recommended-action prose leaked into the snapshot");
  // Active tickets contribute IDS only — no titles. (The referenced ticket DOES
  // carry a title, but that is the bounded Picked-up-next set, not every active row.)
  assert.equal(
    (json.match(/UNIQUE_ACTIVE_TITLE_SHOULD_NOT_APPEAR/g) ?? []).length,
    1,
    "every active ticket title re-entered the snapshot — only the referenced ticket's title should appear",
  );
});

// ---- helpers ---------------------------------------------------------------

test("extractHandoffField stops at the next known heading and is case-insensitive", () => {
  const notes = "**Where we left off:** A thread.\n\n**Picked up next:** move one; move two.\n\n**Shipped (for reference):** x.";
  assert.equal(extractHandoffField(notes, "Where we left off"), "A thread.");
  assert.equal(extractHandoffField(notes, "Picked up next"), "move one; move two.");
  assert.equal(extractHandoffField(notes, "Memories this session may have invalidated"), undefined);
});

test("extractTicketRefs handles prefixed ids and bare sticky numbers, deduped in order", () => {
  assert.deepEqual(extractTicketRefs("finish FG-588, then #600 and FG-588 again, plus #12", "FG"), [
    "FG-588",
    "FG-600",
    "FG-12",
  ]);
  assert.deepEqual(extractTicketRefs("no refs here", "FG"), []);
});

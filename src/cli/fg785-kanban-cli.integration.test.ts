// FG-785 (external kanban projection, OUTBOUND-ONLY) — the operator CLI surface, exercised
// through the REAL `forge kanban` command against a fresh on-disk forge.db. Store-touching and
// process-spawning by definition, so this is *.integration.test.ts, not unit.
//
// It proves AC7 at the CLI seam:
//   - `forge kanban sync` SHELLS into the real dashboard entry and forwards --project/--provider;
//     an unknown project surfaces the entry's NAMED error and a nonzero exit — proving the full
//     core->entry shell path (the green convergent sync itself is proven by the step-4
//     sync.integration test and driven through this CLI by the step-7 credential-leak test).
//   - `forge kanban status` lists the durable projection map for a project/provider.
//   - `forge kanban conflicts` lists OPEN conflicts carrying both versions.
//   - `forge kanban conflicts-resolve` writes the AUTHORIZED resolution that closes the store row,
//     so the conflict stops appearing (and thus the attention-inbox item clears on next projection).
//   - the help text names one-way projection as the default and states NO inbound actions ship.
//
// The CLI is spawned in dev mode (`node --import tsx src/cli/index.ts`) rather than against the
// built mirror: `sync` shells into dashboard/src/kanban/cli-entry.ts, which the built src-only
// mirror does not carry — dev-mode resolution points assetRoot() at the real checkout, where
// dashboard/ exists.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FORGE_HOME / scan roots must be set BEFORE any import that transitively evaluates src/util/paths.ts.
const root = mkdtempSync(join(tmpdir(), "fg785-kanban-cli-"));
const forgeHome = join(root, "home");
mkdirSync(forgeHome, { recursive: true });
process.env.FORGE_HOME = forgeHome;
const scanRoots = join(root, "scan-roots");
mkdirSync(scanRoots, { recursive: true });
process.env.FORGE_PROJECT_SCAN_ROOTS = scanRoots;

const { getDb } = await import("../store/db.js");
const kanban = await import("../store/kanban-projection.js");
const { SRC_DIR, NODE_EXEC } = await import("../integration-cli-spawn.js");

const CLI_ENTRY = join(SRC_DIR, "cli", "index.ts");

const PK = "pk-fg785-cli";
const PROVIDER = "fake";
const AT = "2026-09-08T00:00:00Z";

/** Spawn the real `forge kanban …` CLI in dev mode against the shared FORGE_HOME. */
function runKanban(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(NODE_EXEC, ["--import", "tsx", CLI_ENTRY, "kanban", ...args], {
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...process.env,
      FORGE_HOME: forgeHome,
      FORGE_PROJECT_SCAN_ROOTS: scanRoots,
      NO_NOTIFY: "true",
    },
  });
}

before(() => {
  // A fresh production open materializes the schema (both FG-785 tables included). Seed the
  // durable state the read/resolve verbs inspect — two projected cards and one OPEN conflict —
  // directly through the tested accessors (the same ones the sync engine writes through).
  getDb();

  kanban.upsertProjectionMap({
    projectIdentity: PK,
    ticketIdentity: "FG-A1",
    provider: PROVIDER,
    externalCardId: "card-a1",
    projectionState: "active",
    lastProjectedHash: "a".repeat(64),
    projectedBy: "kanban-sync",
    projectedAt: AT,
    createdAt: AT,
  });
  kanban.upsertProjectionMap({
    projectIdentity: PK,
    ticketIdentity: "FG-A2",
    provider: PROVIDER,
    externalCardId: "card-a2",
    projectionState: "archived",
    lastProjectedHash: "b".repeat(64),
    projectedBy: "kanban-sync",
    projectedAt: AT,
    createdAt: AT,
  });

  kanban.insertConflict({
    id: "conflict-fg785-1",
    projectIdentity: PK,
    ticketIdentity: "FG-A1",
    provider: PROVIDER,
    externalCardId: "card-a1",
    kind: "moved",
    forgeVersion: { laneId: "todo", title: "Alpha one" },
    externalVersion: { laneId: "done", title: "Alpha one" },
    detectedBy: "kanban-sync",
    detectedAt: AT,
    createdAt: AT,
  });
});

// ─── AC7: help states the one-way, no-inbound guarantee ─────────────────────────────

test("AC7: `forge kanban --help` names one-way projection as the default and states NO inbound actions ship", () => {
  const r = runKanban(["--help"]);
  assert.equal(r.status, 0, `help must exit 0\nstderr: ${r.stderr}`);
  const out = String(r.stdout);
  assert.match(out, /one-way/i, "help names one-way projection as the default");
  assert.match(out, /NO inbound/i, "help states no inbound planning actions are enabled");
});

test("AC7: `forge kanban sync --help` repeats the one-way / no-inbound guarantee", () => {
  const r = runKanban(["sync", "--help"]);
  assert.equal(r.status, 0, `help must exit 0\nstderr: ${r.stderr}`);
  const out = String(r.stdout);
  assert.match(out, /outbound only/i);
  assert.match(out, /NO inbound/i);
});

// ─── AC7: sync shells into the real dashboard entry ─────────────────────────────────

test("AC7: `forge kanban sync` shells into the dashboard entry, forwards --project, and surfaces the entry's named error + nonzero exit", () => {
  // An unknown project reaches the REAL entry (defaultBoardSource), which throws a NAMED,
  // credential-free error and exits nonzero. Asserting on that message proves the full
  // core CLI -> spawn -> dashboard cli-entry seam without depending on a seeded board.
  const r = runKanban(["sync", "--project", "does-not-exist", "--provider", "fake"]);
  assert.notEqual(r.status, 0, "an unknown project must fail nonzero");
  assert.match(
    String(r.stderr),
    /is not known to this host/,
    "the entry's named error is surfaced through the shelling CLI",
  );
});

test("`forge kanban sync` without --project is refused by commander (required option)", () => {
  const r = runKanban(["sync"]);
  assert.notEqual(r.status, 0);
  assert.match(String(r.stderr), /--project/, "the missing required option is named");
});

// ─── AC7: status lists the durable projection map ───────────────────────────────────

test("AC7: `forge kanban status --json` lists the durable Forge->card projection map", () => {
  const r = runKanban(["status", "--project", PK, "--provider", PROVIDER, "--json"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(String(r.stdout)) as {
    project: string;
    provider: string;
    count: number;
    cards: Array<{ ticketIdentity: string; projectionState: string; externalCardId: string }>;
  };
  assert.equal(parsed.project, PK);
  assert.equal(parsed.count, 2, "both projected cards are listed");
  const byTicket = new Map(parsed.cards.map((c) => [c.ticketIdentity, c]));
  assert.equal(byTicket.get("FG-A1")?.externalCardId, "card-a1");
  assert.equal(byTicket.get("FG-A2")?.projectionState, "archived");
});

// ─── AC7/AC5: conflicts lists OPEN conflicts with both versions ─────────────────────

test("AC5: `forge kanban conflicts --json` lists the OPEN conflict carrying both versions", () => {
  const r = runKanban(["conflicts", "--project", PK, "--json"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(String(r.stdout)) as {
    count: number;
    conflicts: Array<{ id: string; kind: string; forgeVersion: unknown; externalVersion: unknown; state: string }>;
  };
  assert.equal(parsed.count, 1);
  const c = parsed.conflicts[0]!;
  assert.equal(c.id, "conflict-fg785-1");
  assert.equal(c.kind, "moved");
  assert.equal(c.state, "open");
  assert.ok(c.forgeVersion, "the Forge canonical version is carried");
  assert.ok(c.externalVersion, "the external version is carried");
});

// ─── AC7/AC5: conflicts-resolve is the authorized closing write ─────────────────────

test("AC7/AC5: `forge kanban conflicts-resolve` closes the store row, so the conflict stops surfacing", () => {
  const resolved = runKanban([
    "conflicts-resolve",
    "conflict-fg785-1",
    "--by",
    "operator@host",
    "--note",
    "reconciled by hand",
    "--json",
  ]);
  assert.equal(resolved.status, 0, `stderr: ${resolved.stderr}`);
  const parsed = JSON.parse(String(resolved.stdout)) as { ok: boolean; conflictId: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.conflictId, "conflict-fg785-1");

  // The store row is the resolution authority: a resolved conflict no longer appears as open,
  // which is exactly what clears the attention-inbox item on its next projection (AC5).
  const after = runKanban(["conflicts", "--project", PK, "--json"]);
  assert.equal(after.status, 0, `stderr: ${after.stderr}`);
  const openAfter = JSON.parse(String(after.stdout)) as { count: number };
  assert.equal(openAfter.count, 0, "the resolved conflict no longer surfaces as open");
});

test("`forge kanban conflicts-resolve` on an already-resolved conflict fails nonzero, not silently", () => {
  const r = runKanban(["conflicts-resolve", "conflict-fg785-1", "--json"]);
  assert.notEqual(r.status, 0, "re-resolving a closed conflict is not a silent success");
  const parsed = JSON.parse(String(r.stdout)) as { ok: boolean; error: string };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "already-resolved");
});

test("`forge kanban conflicts-resolve` on an unknown id reports not-found and exits nonzero", () => {
  const r = runKanban(["conflicts-resolve", "no-such-conflict", "--json"]);
  assert.notEqual(r.status, 0);
  const parsed = JSON.parse(String(r.stdout)) as { ok: boolean; error: string };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "not-found");
});

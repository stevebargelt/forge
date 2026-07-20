// FG-564 (Slice 5b, D4): `forge campaign continue` — the per-wake sibling of `forge campaign
// recover`, exercised end-to-end through the REAL built CLI entry (spawned tsx) against a real
// on-disk forge.db under a temp FORGE_HOME.
//
// D4 names BOTH `continue` and `recover` as the campaign operator surface; both reuse the same
// shared campaign consumer core (never a fork of continue.ts). The recover CLI is covered by
// fg564-campaign-recover-cli.integration.test.ts; this file proves the `continue` subcommand is
// actually REGISTERED and honors the SAME lease-gated fail-closed contract end-to-end: it fails
// closed with no stable controller identity (P1-D), fails closed while a DIFFERENT owner's lease
// is live (AC8), and recovers cleanly once no live lease blocks it — without manual SQL.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let forgeHome: string;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg564-continue-home-"));
});
afterEach(() => {
  rmSync(forgeHome, { recursive: true, force: true });
});

function openDb(): Database.Database {
  const db = new Database(join(forgeHome, "forge.db"));
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

function seedRunningCampaign(db: Database.Database): string {
  const cid = "cmp-continue-1";
  db.prepare(
    `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir)
     VALUES (?, 'running', 'list', ?, 'sequential', 't', 't', '/tmp/proj')`,
  ).run(cid, JSON.stringify({ kind: "list", ticketIds: ["A"] }));
  db.prepare(
    `INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, lifecycle_status, attempt_generation, created_at, updated_at)
     VALUES ('item-1', ?, 0, 'A', 'running', 1, 't', 't')`,
  ).run(cid);
  return cid;
}

function runForge(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true", ...extraEnv },
  });
}

test("campaign continue: is a registered subcommand and FAILS CLOSED with no stable controller identity", () => {
  const db = openDb();
  seedRunningCampaign(db);
  db.close();
  const r = runForge(["campaign", "continue", "cmp-continue-1", "--json"], { FORGE_CONTROLLER_ID: "" });
  // A registered command that fails closed exits 1 with the identity message — NOT commander's
  // "unknown command" (which would also be nonzero but carry a different message).
  assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /stable controller identity/i);
  assert.doesNotMatch(r.stderr, /unknown command/i, "continue must be a real registered subcommand");
});

test("campaign continue: FAILS CLOSED while a DIFFERENT owner's lease is LIVE", () => {
  const db = openDb();
  const cid = seedRunningCampaign(db);
  db.prepare(
    `INSERT INTO campaign_controller_leases (campaign_id, owner, generation, lease_expires_at_ms, created_at, updated_at)
     VALUES (?, ?, 1, ?, 't', 't')`,
  ).run(cid, `campaign@${cid}@A`, Date.now() + 60 * 60 * 1000);
  db.close();

  const r = runForge(["campaign", "continue", cid, "--json"], { FORGE_CONTROLLER_ID: "instance-B" });
  assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /lease_held_live/);

  // The live lease is untouched — a continue wake by a different instance never renews it.
  const db2 = new Database(join(forgeHome, "forge.db"), { readonly: true });
  const lease = db2
    .prepare(`SELECT owner, generation FROM campaign_controller_leases WHERE campaign_id = ?`)
    .get(cid) as { owner: string; generation: number };
  db2.close();
  assert.equal(lease.owner, `campaign@${cid}@A`, "live owner A unchanged");
  assert.equal(lease.generation, 1, "generation not bumped by a fail-closed continue");
});

test("campaign continue: succeeds when no live lease blocks it (fresh lease, nothing to adopt)", () => {
  const db = openDb();
  const cid = seedRunningCampaign(db);
  // The sole item already shipped — the loop-continuation finds nothing to drive and finalizes.
  db.prepare(`UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE campaign_id = ?`).run(cid);
  db.close();

  const r = runForge(["campaign", "continue", cid, "--json"], { FORGE_CONTROLLER_ID: "instance-B" });
  assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as {
    ok: boolean;
    status: string;
    mode: string;
    adopted: number;
    loopStop?: string;
    lease: { owner: string };
  };
  assert.equal(out.ok, true);
  assert.equal(out.status, "recovered");
  assert.equal(out.mode, "created");
  assert.equal(out.adopted, 0, "no in-flight continuations — nothing to adopt");
  assert.match(out.lease.owner, /instance-B/);
  assert.equal(out.loopStop, "complete", "continue drives the item loop to completion");

  // D1: the lease is released once the campaign is terminal.
  const db2 = new Database(join(forgeHome, "forge.db"), { readonly: true });
  const lease = db2.prepare(`SELECT owner FROM campaign_controller_leases WHERE campaign_id = ?`).get(cid);
  const status = db2.prepare(`SELECT status FROM campaigns WHERE id = ?`).get(cid) as { status: string };
  db2.close();
  assert.equal(lease, undefined, "the controller lease is released once the campaign completes");
  assert.equal(status.status, "complete");
});

test("campaign continue: not_found for an unknown campaign id", () => {
  openDb().close();
  const r = runForge(["campaign", "continue", "cmp-nope", "--json"], { FORGE_CONTROLLER_ID: "instance-B" });
  assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /not_found/);
});

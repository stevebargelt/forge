// FG-564 (Slice 5b, AC8/D4): `forge campaign recover` / `forge campaign continue` CLI wiring,
// exercised end-to-end through the REAL built CLI entry (spawned tsx) against a real on-disk
// forge.db under a temp FORGE_HOME. Proves the operator surface: fail-closed owner resolution
// (a host-stable owner cannot fence a same-host peer), fail-closed while a DIFFERENT owner's
// lease is LIVE, and a clean recovery (lease taken over, in-flight adopted) once no live lease
// blocks it.

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
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let forgeHome: string;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg564-recover-home-"));
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
  const cid = "cmp-recover-1";
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

test("campaign recover: FAILS CLOSED when no stable controller identity resolves", () => {
  const db = openDb();
  seedRunningCampaign(db);
  db.close();
  // No FORGE_CONTROLLER_ID (provider-neutral identity) — must refuse to mutate.
  const r = runForge(["campaign", "recover", "cmp-recover-1", "--json"], {
    FORGE_CONTROLLER_ID: "",
  });
  assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /stable controller identity/i);
});

test("P1-D: --owner is NOT accepted — a caller cannot supply a live controller's owner to renew/impersonate its lease", () => {
  const db = openDb();
  const cid = seedRunningCampaign(db);
  const expiry = Date.now() + 60 * 60 * 1000;
  db.prepare(
    `INSERT INTO campaign_controller_leases (campaign_id, owner, generation, lease_expires_at_ms, created_at, updated_at)
     VALUES (?, ?, 1, ?, 't', 't')`,
  ).run(cid, `campaign@${cid}@A`, expiry);
  db.close();

  // A caller tries to impersonate live owner A via --owner. The flag no longer exists, so the
  // caller's identity is its own env instance (B) — it must NOT renew/impersonate A's live lease.
  const r = runForge(["campaign", "recover", cid, "--owner", `campaign@${cid}@A`, "--json"], {
    FORGE_CONTROLLER_ID: "instance-B",
  });
  assert.notEqual(r.status, 0, `impersonation attempt must not succeed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

  // A's live lease is untouched: same owner, same generation, same expiry — never renewed by B.
  const db2 = new Database(join(forgeHome, "forge.db"), { readonly: true });
  const lease = db2
    .prepare(`SELECT owner, generation, lease_expires_at_ms FROM campaign_controller_leases WHERE campaign_id = ?`)
    .get(cid) as { owner: string; generation: number; lease_expires_at_ms: number };
  db2.close();
  assert.equal(lease.owner, `campaign@${cid}@A`, "live owner A must be unchanged");
  assert.equal(lease.generation, 1, "generation must not have been bumped or renewed");
  assert.equal(lease.lease_expires_at_ms, expiry, "expiry must not have been extended by an impersonator");
});

test("campaign recover: FAILS CLOSED while a DIFFERENT owner's lease is LIVE", () => {
  const db = openDb();
  const cid = seedRunningCampaign(db);
  // A live lease held by controller A, far in the future.
  db.prepare(
    `INSERT INTO campaign_controller_leases (campaign_id, owner, generation, lease_expires_at_ms, created_at, updated_at)
     VALUES (?, ?, 1, ?, 't', 't')`,
  ).run(cid, `campaign@${cid}@A`, Date.now() + 60 * 60 * 1000);
  db.close();

  // Controller B attempts recovery — must fail closed while A's lease is live.
  const r = runForge(["campaign", "recover", cid, "--json"], { FORGE_CONTROLLER_ID: "instance-B" });
  assert.equal(r.status, 1, `expected exit 1\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /lease_held_live/);
});

test("campaign recover: succeeds when no live lease blocks it, then continues the item loop to completion (P1-G)", () => {
  const db = openDb();
  const cid = seedRunningCampaign(db);
  // The sole item already shipped — so P1-G's loop-continuation finds nothing left to drive and
  // finalizes the campaign deterministically (no tmux/launch dependency in this unit rig).
  db.prepare(`UPDATE campaign_items SET lifecycle_status = 'complete', outcome = 'shipped' WHERE campaign_id = ?`).run(cid);
  db.close();

  const r = runForge(["campaign", "recover", cid, "--json"], { FORGE_CONTROLLER_ID: "instance-B" });
  assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { ok: boolean; status: string; mode: string; adopted: number; loopStop?: string; lease: { owner: string } };
  assert.equal(out.ok, true);
  assert.equal(out.status, "recovered");
  assert.equal(out.mode, "created");
  assert.equal(out.adopted, 0, "no in-flight continuations yet — nothing to adopt");
  // The lease B acquired during recovery is reported in the result.
  assert.match(out.lease.owner, /instance-B/);
  // P1-G continued the item loop; with the item already shipped the campaign finalizes.
  assert.equal(out.loopStop, "complete", "recover continued the loop to completion");

  // D1: the lease is settled once the campaign becomes terminal (released after the loop).
  const db2 = new Database(join(forgeHome, "forge.db"), { readonly: true });
  const lease = db2.prepare(`SELECT owner FROM campaign_controller_leases WHERE campaign_id = ?`).get(cid);
  const status = db2.prepare(`SELECT status FROM campaigns WHERE id = ?`).get(cid) as { status: string };
  db2.close();
  assert.equal(lease, undefined, "the controller lease is released once the campaign completes");
  assert.equal(status.status, "complete");
});

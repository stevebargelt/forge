// Adversarial regression tests for FG-389 --search on the structured backlog path.
// Each fixture is a real structured backlog in a real temp dir — no mocks, no shims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTicket, listTickets, type StructuredTicket } from "./structured.js";

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg389-adv-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  return dir;
}

function ticket(overrides: Partial<StructuredTicket> = {}): StructuredTicket {
  return {
    id: "FG-1",
    type: "story",
    status: "active",
    title: "placeholder",
    body: "placeholder body",
    ...overrides,
  };
}

// ─── (1) Case-insensitivity: UPPER search vs lowercase content ─────────────────

test("FG-389 adv: UPPER case search matches lowercase title", () => {
  const dir = makeTmpDir();
  writeTicket(dir, ticket({ id: "FG-1", title: "implement oauth login", body: "auth via pkce" }));
  writeTicket(dir, ticket({ id: "FG-2", title: "fix typo in readme", body: "just a typo fix" }));
  const results = listTickets(dir, { search: "OAUTH" });
  assert.equal(results.length, 1, "UPPER search must match lowercase title");
  assert.equal(results[0]!.id, "FG-1");
});

test("FG-389 adv: UPPER case search matches lowercase body", () => {
  const dir = makeTmpDir();
  writeTicket(dir, ticket({ id: "FG-1", title: "Feature Q", body: "refactor the widgetfactory class" }));
  writeTicket(dir, ticket({ id: "FG-2", title: "Feature R", body: "completely different content" }));
  const results = listTickets(dir, { search: "WIDGETFACTORY" });
  assert.equal(results.length, 1, "UPPER search must match lowercase body");
  assert.equal(results[0]!.id, "FG-1");
});

test("FG-389 adv: mixed-case search term matches all-uppercase title", () => {
  const dir = makeTmpDir();
  writeTicket(dir, ticket({ id: "FG-1", title: "ADD DATABASE MIGRATIONS", body: "schema change required" }));
  writeTicket(dir, ticket({ id: "FG-2", title: "update docs", body: "fix spelling" }));
  const results = listTickets(dir, { search: "database" });
  assert.equal(results.length, 1, "lowercase search must match UPPERCASE title");
  assert.equal(results[0]!.id, "FG-1");
});

// ─── (2) --search + --status + --type triple intersection ─────────────────────

test("FG-389 adv: search + type + status trims to exactly the matching ticket", () => {
  const dir = makeTmpDir();
  // Target: story + active + "auth"
  writeTicket(dir, ticket({ id: "FG-1", type: "story", status: "active", title: "auth login story" }));
  // Wrong type
  writeTicket(dir, ticket({ id: "FG-2", type: "epic", status: "active", title: "auth epic" }));
  // Wrong status (done → stored in done/)
  writeTicket(dir, ticket({ id: "FG-3", type: "story", status: "done", title: "auth old story" }));
  // Wrong keyword
  writeTicket(dir, ticket({ id: "FG-4", type: "story", status: "active", title: "unrelated story" }));

  const results = listTickets(dir, { search: "auth", type: "story", status: "active" });
  assert.equal(results.length, 1, "triple filter must yield exactly one ticket");
  assert.equal(results[0]!.id, "FG-1");
});

test("FG-389 adv: search + type=epic + status=done returns only that done epic", () => {
  const dir = makeTmpDir();
  writeTicket(dir, ticket({ id: "FG-1", type: "epic",  status: "done",   title: "auth epic done" }));
  writeTicket(dir, ticket({ id: "FG-2", type: "epic",  status: "active", title: "auth epic active" }));
  writeTicket(dir, ticket({ id: "FG-3", type: "story", status: "done",   title: "auth story done" }));
  writeTicket(dir, ticket({ id: "FG-4", type: "idea",  status: "done",   title: "auth idea done" }));

  const results = listTickets(dir, { search: "auth", type: "epic", status: "done" });
  assert.equal(results.length, 1, "only the done epic should survive triple filter");
  assert.equal(results[0]!.id, "FG-1");
});

test("FG-389 adv: search + type=idea + status=active excludes done ideas and non-ideas", () => {
  const dir = makeTmpDir();
  writeTicket(dir, ticket({ id: "FG-1", type: "idea",  status: "active", title: "cache warming idea" }));
  writeTicket(dir, ticket({ id: "FG-2", type: "idea",  status: "done",   title: "cache old idea" }));
  writeTicket(dir, ticket({ id: "FG-3", type: "story", status: "active", title: "cache story" }));

  const results = listTickets(dir, { search: "cache", type: "idea", status: "active" });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.id, "FG-1");
});

// ─── (3) Body-only match: title has zero overlap with search term ──────────────

test("FG-389 adv: body-only match returned when title is completely unrelated", () => {
  const dir = makeTmpDir();
  // Title "Sprint Planning Notes" — no shared substring with "xyzzy-protocol"
  writeTicket(dir, ticket({ id: "FG-1", title: "Sprint Planning Notes", body: "The xyzzy-protocol handler needs investigation" }));
  writeTicket(dir, ticket({ id: "FG-2", title: "Another task", body: "Nothing relevant here" }));
  const results = listTickets(dir, { search: "xyzzy-protocol" });
  assert.equal(results.length, 1, "body-only match must be returned");
  assert.equal(results[0]!.id, "FG-1");
});

test("FG-389 adv: abbreviated title does not prevent body match", () => {
  const dir = makeTmpDir();
  // Title has "db" but NOT "database"; body has the full word "database"
  writeTicket(dir, ticket({ id: "FG-1", title: "Improve db perf", body: "The database query planner needs a hint index" }));
  writeTicket(dir, ticket({ id: "FG-2", title: "Unrelated ticket", body: "Nothing about storage" }));
  const results = listTickets(dir, { search: "database" });
  assert.equal(results.length, 1, "body match must not require title to match");
  assert.equal(results[0]!.id, "FG-1");
});

test("FG-389 adv: multiline body match is found on any line", () => {
  const dir = makeTmpDir();
  writeTicket(dir, ticket({
    id: "FG-1",
    title: "Rollout plan",
    body: "Phase 1: feature flags\nPhase 2: canary deploy\nPhase 3: xyzzy-token validation\nPhase 4: cleanup",
  }));
  writeTicket(dir, ticket({ id: "FG-2", title: "Other ticket", body: "nothing\nspecial\nhere" }));
  const results = listTickets(dir, { search: "xyzzy-token" });
  assert.equal(results.length, 1, "match must work across multiline body");
  assert.equal(results[0]!.id, "FG-1");
});

// ─── (4) Nonsense search returns ZERO tickets (original FG-389 regression) ────

test("FG-389 adv: nonsense search with realistic tickets returns empty — original bug repro", () => {
  const dir = makeTmpDir();
  // Realistic-looking auth-related backlog, which was the domain of the original report
  writeTicket(dir, ticket({ id: "FG-1", type: "story", status: "active", title: "Implement OAuth2 login flow", body: "Use PKCE + authorization code flow" }));
  writeTicket(dir, ticket({ id: "FG-2", type: "epic",  status: "active", title: "Auth system overhaul", body: "Migrate from session tokens to JWTs" }));
  writeTicket(dir, ticket({ id: "FG-3", type: "idea",  status: "active", title: "Explore WebAuthn support", body: "Passkey / FIDO2 for passwordless login" }));
  writeTicket(dir, ticket({ id: "FG-4", type: "story", status: "done",   title: "Fix login redirect loop", body: "Middleware re-issued challenges on authenticated requests" }));

  const results = listTickets(dir, { search: "xq9zznotarealword99" });
  assert.equal(results.length, 0, "nonsense search must return 0 — FG-389 original bug was returning all tickets");
});

test("FG-389 adv: search for ticket ID prefix returns zero if ID not in title or body", () => {
  const dir = makeTmpDir();
  // Ticket IDs are NOT part of the search haystack (title + body only)
  writeTicket(dir, ticket({ id: "FG-1", title: "Deploy to production", body: "Update manifests" }));
  writeTicket(dir, ticket({ id: "FG-2", title: "Update docs", body: "Fix spelling" }));
  // Searching for an ID-style string that matches no title or body content
  const results = listTickets(dir, { search: "FG-NONEXISTENT" });
  assert.equal(results.length, 0, "ID-prefix search must return 0 when title/body don't match");
});

test("FG-389 adv: empty backlog + search returns empty, no crash", () => {
  const dir = makeTmpDir();
  // No tickets at all
  const results = listTickets(dir, { search: "anything" });
  assert.equal(results.length, 0, "empty backlog with search must return empty array");
});

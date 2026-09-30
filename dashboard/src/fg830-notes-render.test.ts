// FG-830: the Notes view's pure rules (client/notes-render.js), its trail and header, the
// sanitized note body, and the #notes route. The browser suite
// (browser-tests/fg830-notes-view.test.ts) renders the same rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_PROJECT_MESSAGE,
  lastSessionDate,
  notePreview,
  noteRowFor,
  noteRows,
  sessionDisplay,
  sessionOf,
} from "../client/notes-render.js";
import { noteTrail, parentHash } from "../client/breadcrumbs-render.js";
import { listHeader, noteHeader } from "../client/screen-header-render.js";
import { md } from "../client/markdown.js";
import { NAV_GROUPS, ROUTES, hashFor, navItemFor, parseHash } from "../client/view-routing.js";

const PROJECTS = [{
  key: "repo-forge",
  label: "Forge",
  primaryCheckout: "/Users/s/code/forge",
  checkouts: [
    { projectDir: "/Users/s/code/forge", branch: "main", exists: true },
    { projectDir: "/tmp/forge-clones/run-1/forge", branch: "main", exists: true },
    { projectDir: "/Users/s/code/forge-fg830", branch: "feat/fg-830-notes-view", exists: true },
    { projectDir: "/Users/s/code/forge-quiet", branch: "feat/quiet", exists: true },
  ],
}];
const SCOPE = { project: "repo-forge", checkout: null };
const DATA = {
  notesByCheckout: [
    { checkoutDir: "/Users/s/code/forge", checkoutBranch: "main", notes: "**Last session ended 2026-08-13.**\n\n**Where we left off:** three tickets shipped.", modifiedAt: "2026-09-01T00:00:00.000Z" },
    { checkoutDir: "/tmp/forge-clones/run-1/forge", checkoutBranch: "main", notes: "# Clone handoff\n\nNo session line here.", modifiedAt: "2026-09-20T10:00:00.000Z" },
    { checkoutDir: "/Users/s/code/forge-fg830", checkoutBranch: "feat/fg-830-notes-view", notes: "Last session ended 2026-09-28.\n\n- Notes view half done", modifiedAt: null },
    { checkoutDir: "/Users/s/code/forge-quiet", checkoutBranch: "feat/quiet", notes: "Undated scribble", modifiedAt: null },
    { checkoutDir: "/Users/s/code/forge-empty", checkoutBranch: "main", notes: "   \n", modifiedAt: null },
  ],
};

test("FG-830: the session date is the note's own line, else the file mtime, else honestly unknown", () => {
  assert.equal(lastSessionDate("**Last session ended 2026-08-13.**\n\nbody"), "2026-08-13");
  assert.equal(lastSessionDate("no date here"), null);
  assert.equal(lastSessionDate("Last session ended 2026-13-45."), null, "an impossible date is not a date");
  assert.deepEqual(sessionOf(DATA.notesByCheckout[0]), { iso: "2026-08-13", source: "note" }, "the note wins over the mtime");
  assert.deepEqual(sessionOf(DATA.notesByCheckout[1]), { iso: "2026-09-20T10:00:00.000Z", source: "modified" });
  assert.deepEqual(sessionOf(DATA.notesByCheckout[3]), { iso: null, source: "unknown" });
  const now = Date.parse("2026-09-30T00:00:00.000Z");
  assert.equal(sessionDisplay({ iso: "2026-09-28", source: "note" }, now).text, "session ended 2026-09-28 · 2d ago");
  assert.match(sessionDisplay({ iso: "2026-09-20T10:00:00.000Z", source: "modified" }, now).text, /^file modified 9d ago$/);
  assert.equal(sessionDisplay({ iso: null, source: "unknown" }, now).text, "session date unknown");
});

test("FG-830: the preview is one line of prose — markup stripped, the session line skipped, truncated", () => {
  assert.equal(notePreview("**Last session ended 2026-08-13.**\n\n**Where we left off:** three tickets shipped."), "Where we left off: three tickets shipped.");
  assert.equal(notePreview("# Clone handoff\n\nbody"), "Clone handoff");
  assert.equal(notePreview("\n\n- first bullet\n- second"), "first bullet");
  const long = notePreview("x".repeat(400));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith("…"));
  assert.doesNotMatch(notePreview("line one\nline two"), /\n/);
});

test("FG-830: one row per checkout with a note, FG-831 labels, primary marked, newest session first", () => {
  const rows = noteRows(DATA, SCOPE, PROJECTS);
  assert.deepEqual(rows.map((r) => r.label), [
    "forge-fg830 · feat/fg-830-notes-view",
    "run-1/forge · main",
    "code/forge · main",
    "forge-quiet · feat/quiet",
  ], "2026-09-28 note, 2026-09-20 mtime, 2026-08-13 note, then unknown last; the blank note has no row");
  assert.equal(new Set(rows.map((r) => r.label)).size, rows.length, "labels are unique among the project's checkouts");
  assert.deepEqual(rows.filter((r) => r.primary).map((r) => r.checkoutDir), ["/Users/s/code/forge"]);
  assert.equal(rows[0]!.branch, "feat/fg-830-notes-view");
  assert.equal(rows[0]!.href, `#notes/${encodeURIComponent("/Users/s/code/forge-fg830")}?project=repo-forge`);
  assert.equal(noteRowFor(rows, "/Users/s/code/forge/")?.label, "code/forge · main", "a trailing separator names the same checkout");
  assert.equal(noteRowFor(rows, "/nowhere"), null);
  assert.deepEqual(noteRows(null, SCOPE, PROJECTS), []);
  assert.deepEqual(noteRows({ notesByCheckout: [] }, SCOPE, PROJECTS), []);
  assert.match(NO_PROJECT_MESSAGE, /Select a project/);
});

test("FG-830: the note page's trail is Project › Notes › checkout, Escape goes to the scoped Notes list", () => {
  const trail = noteTrail("code/forge · main", SCOPE, PROJECTS);
  assert.deepEqual(trail.map((c) => [c.kind, c.label, c.href]), [
    ["project", "Forge", "#runs?project=repo-forge"],
    ["notes", "Notes", "#notes?project=repo-forge"],
    ["note", "code/forge · main", null],
  ]);
  assert.equal(parentHash("note", null, SCOPE), "#notes?project=repo-forge");
  assert.equal(noteHeader({ label: "code/forge · main" }).verb, "forge backlog notes show");
  assert.equal(noteHeader(null).happening, "No note for this checkout");
  const list = listHeader("notes");
  assert.ok(list && list.happening && list.needs && list.todo);
});

test("FG-830: the note body goes through the sanitized renderer — raw HTML shows as text, nothing scriptable survives", () => {
  const out = md("# Handoff\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) <img src=x onerror=alert(1)>", { html: "text" });
  assert.match(out, /<h1[^>]*>Handoff<\/h1>/);
  assert.doesNotMatch(out, /<script|<img|<a |href="javascript:/i, "no live tag or scriptable link survives");
  assert.match(out, /&lt;script&gt;/, "the raw tag is visible as literal text");
});

test("FG-830: #notes is a Plan route after Backlog, project-optional, with an optional checkout segment", () => {
  assert.deepEqual(NAV_GROUPS.find((g) => g.id === "plan")?.items, ["backlog", "notes", "queue", "campaigns"]);
  assert.equal(ROUTES.notes?.scope, "optional");
  assert.equal(ROUTES.notes?.object, "optional");
  assert.equal(navItemFor("notes"), "notes");

  const list = parseHash("#notes?project=repo-forge");
  assert.deepEqual([list.view, list.group, list.id, list.scope, list.rewrite], ["notes", "plan", null, { project: "repo-forge", checkout: null }, false]);

  const dir = "/Users/s/code/forge wt";
  const hash = hashFor({ view: "notes", id: dir, scope: SCOPE });
  assert.equal(hash, `#notes/${encodeURIComponent(dir)}?project=repo-forge`);
  const page = parseHash(hash);
  assert.deepEqual([page.view, page.id, page.rewrite], ["notes", dir, false], "a checkout path round-trips through the hash");

  const grouped = parseHash("#plan/notes?project=repo-forge");
  assert.deepEqual([grouped.view, grouped.canonical, grouped.rewrite], ["notes", "#notes?project=repo-forge", true], "a group-shaped prefix canonicalizes");
  assert.equal(parseHash("#notes").rewrite, false, "no project is a valid Notes hash — the view asks for one");
  assert.equal(parseHash("#notes?project=repo-forge&type=story").canonical, "#notes?project=repo-forge", "backlog-only params are dropped");
  assert.equal(parseHash("#backlog?project=repo-forge").view, "backlog", "Backlog keeps its own route");
});

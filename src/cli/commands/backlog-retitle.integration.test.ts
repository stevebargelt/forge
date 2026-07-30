// Integration tests for FG-360: forge backlog retitle verb, and the edit
// re-slug/orphan bug (body-only edit must never move the file).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityTestkitEnv, withAuthorityTestkit } from "../../backlog/container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const localTsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

let projectDir: string;

function runForge(args: string[], input = "") {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: projectDir,
    input,
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
}

function setupStructured(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  mkdirSync(join(projectDir, "backlog", "stories"), { recursive: true });
  mkdirSync(join(projectDir, "backlog", "done"), { recursive: true });
  mkdirSync(join(projectDir, "backlog", "epics"), { recursive: true });
  mkdirSync(join(projectDir, "backlog", "ideas"), { recursive: true });
}

function filesForId(id: string): string[] {
  const found: string[] = [];
  for (const sub of ["stories", "epics", "ideas", "done"]) {
    const d = join(projectDir, "backlog", sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (f.startsWith(`${id}-`) || f === `${id}.md`) found.push(join(sub, f));
    }
  }
  return found;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "forge-retitle-integ-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test("integ FG-360: body-only edit after a title diverges from the slug does not create a second file", () => {
  setupStructured();
  const fileRes = runForge(["backlog", "file", "Original title", "--project", projectDir]);
  assert.equal(fileRes.status, 0, `stderr: ${fileRes.stderr}`);

  // retitle diverges frontmatter title from the file's slug without touching the filename
  const retitleRes = runForge(["backlog", "retitle", "FG-1", "Something else entirely", "--project", projectDir]);
  assert.equal(retitleRes.status, 0, `stderr: ${retitleRes.stderr}`);
  assert.equal(filesForId("FG-1").length, 1, "retitle must not create a second file");

  const editRes = runForge(
    ["backlog", "edit", "FG-1", "--body", "-", "--project", projectDir],
    "new body content\n",
  );
  assert.equal(editRes.status, 0, `stderr: ${editRes.stderr}`);

  const files = filesForId("FG-1");
  assert.equal(files.length, 1, `exactly one file must exist for FG-1 after edit, got: ${files.join(", ")}`);
});

test("integ FG-360: forge backlog retitle updates frontmatter and show reflects the new title", () => {
  setupStructured();
  runForge(["backlog", "file", "Old title", "--project", projectDir]);

  const retitleRes = runForge(["backlog", "retitle", "FG-1", "Brand new title", "--project", projectDir]);
  assert.equal(retitleRes.status, 0, `stderr: ${retitleRes.stderr}`);
  assert.equal(filesForId("FG-1").length, 1, "exactly one file for FG-1 after retitle");

  const showRes = runForge(["backlog", "show", "FG-1", "--json", "--project", projectDir]);
  assert.equal(showRes.status, 0, `stderr: ${showRes.stderr}`);
  const ticket = JSON.parse(showRes.stdout);
  assert.equal(ticket.title, "Brand new title");
});

test("integ FG-360: list does not double-count a ticket after edit + retitle", () => {
  setupStructured();
  runForge(["backlog", "file", "Original title", "--project", projectDir]);
  runForge(["backlog", "retitle", "FG-1", "Diverged title", "--project", projectDir]);
  runForge(["backlog", "edit", "FG-1", "--body", "edited body", "--project", projectDir]);

  const listRes = runForge(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(listRes.status, 0, `stderr: ${listRes.stderr}`);
  const tickets = JSON.parse(listRes.stdout) as Array<{ id: string }>;
  const matches = tickets.filter((t) => t.id === "FG-1");
  assert.equal(matches.length, 1, "list must show FG-1 exactly once");
});

test("integ FG-360: filing refuses to create a duplicate when a file with that id already exists on disk", () => {
  setupStructured();
  // A stray, unparseable file occupies the id the next `file` call would pick.
  // listTickets skips it when computing max id (parse failure), but the
  // dedupe-by-id guard must still find it via the filename and refuse.
  writeFileSync(join(projectDir, "backlog", "stories", "FG-1-stray.md"), "not valid frontmatter at all\n");

  const res = runForge(["backlog", "file", "New ticket", "--project", projectDir]);
  assert.notEqual(res.status, 0, "filing must fail rather than create a duplicate FG-1");
  assert.match(res.stderr, /already exists|duplicate/i);

  const files = filesForId("FG-1");
  assert.equal(files.length, 1, "only the original stray file may remain for FG-1");
});

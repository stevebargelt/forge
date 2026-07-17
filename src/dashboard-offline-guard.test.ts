// FG-580: the dashboard must boot OFFLINE — no runtime fetch of executable JavaScript
// from a CDN. The client used to `import` Preact/HTM/Marked from https://esm.sh; those
// are now vendored first-party under dashboard/client/vendor/** and resolved via the
// import map in dashboard/src/shell.ts. This guard is the belt against a reintroduced or
// missed external import: it scans every dashboard/client file and FAILS on any module
// specifier that is an http(s) URL (an external, un-content-bound script origin).
//
// It matches URL *specifiers* in import/from statements, not the bare substring "esm.sh"
// — a comment that merely mentions the CDN is fine; an executable import from it is not.
//
// Lives in the root tree (like dashboard-phantom-status.test.ts): a path-scanning guard
// stays on this side of the boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_ROOT = fileURLToPath(new URL("../dashboard/client/", import.meta.url));

// A module specifier that is an http(s) URL: `from "https://…"`, `import "https://…"`,
// or `import("https://…")`. Anchored on the import/from keyword so prose/comments that
// merely name a CDN do not trip the guard.
const EXTERNAL_ORIGIN = /(?:from|import)\s*\(?\s*["']https?:\/\//;

function gatherFiles(dir: string, root: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...gatherFiles(full, root));
    else if (entry.isFile()) results.push(relative(root, full));
  }
  return results;
}

test("FG-580: no dashboard/client file imports executable JS from an external (CDN) origin", () => {
  const files = gatherFiles(CLIENT_ROOT).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
  assert.ok(files.length > 0, "scanned no dashboard/client JS — the path or layout changed");

  const hits: string[] = [];
  for (const rel of files) {
    const body = readFileSync(join(CLIENT_ROOT, rel), "utf8");
    body.split("\n").forEach((line, i) => {
      if (EXTERNAL_ORIGIN.test(line)) hits.push(`dashboard/client/${rel}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    hits,
    [],
    `dashboard/client must import only first-party/vendored modules (offline boot, FG-580) — external-origin imports found:\n${hits.join("\n")}`,
  );
});

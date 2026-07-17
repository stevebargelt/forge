#!/usr/bin/env node
// FG-580 — vendor the dashboard's browser client libraries as first-party,
// committed ESM assets so a promoted release boots WITHOUT fetching executable
// JavaScript from a CDN (esm.sh).
//
// WHY THIS EXISTS
// The dashboard client (dashboard/client/*.js) used to `import` Preact, HTM and
// the browser-side Marked from https://esm.sh at runtime. A supposedly immutable,
// content-addressed release must not execute CDN-delivered code that lives OUTSIDE
// its content binding. This script produces the vendored bytes those imports now
// resolve to (via the import map in dashboard/src/shell.ts).
//
// MECHANISM (deterministic, diffable — npm-dist-derived, NOT a live esm.sh fetch)
//   `npm pack <pkg>@<pinned>` fetches the exact published tarball from the
//   registry, we extract it, and copy the package's own ESM dist bytes VERBATIM
//   into dashboard/client/vendor/<name>/. The vendored files are therefore
//   byte-identical to the upstream published dist, so a version bump is a
//   reviewable diff. No transformation, no bundler, no rewriting of the bytes.
//
//   INTENTIONAL: some upstream dist files end with a `//# sourceMappingURL=…map`
//   trailer pointing at a .map we do NOT ship. This is left AS-IS on purpose —
//   stripping it would break the byte-identical-to-upstream guarantee above (and
//   the commit-bound release binding that rests on it). The trailer is inert at
//   runtime: it is a DevTools-only hint that 404s when devtools is open and is
//   otherwise never fetched. Do NOT "clean" it.
//
// RE-VENDOR ON A VERSION BUMP
//   1. Edit the PINNED versions below.
//   2. Run:  node scripts/vendor-dashboard-libs.mjs
//   3. Review the diff under dashboard/client/vendor/ and commit it.
//   The vendored files are commit-bound release inputs (src/v2/release.ts): a
//   dirty or absent vendored lib refuses the release build by name, and closure
//   validation asserts their presence in a built release.
//
// LAYOUT / IMPORT-MAP CONTRACT (must stay in sync with dashboard/src/shell.ts)
//   preact        -> /client/vendor/preact/preact.js   (self-contained ESM)
//   preact/hooks  -> /client/vendor/preact/hooks.js     (imports bare "preact")
//   htm           -> /client/vendor/htm/htm.js          (self-contained ESM)
//   marked        -> /client/vendor/marked/marked.js    (self-contained ESM)
// hooks.js's internal `import ... from "preact"` is a BARE specifier resolved by
// the import map — that is the single reason the import map exists. Files are
// named `.js` (not `.mjs`) so the dashboard's static server serves them as
// application/javascript; the browser executes them as modules unchanged.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = resolve(HERE, "..", "dashboard", "client", "vendor");

// PINNED versions — the exact esm.sh versions the client imported before vendoring.
// Bump here, then re-run this script and commit the diff.
const LIBS = [
  { pkg: "preact", version: "10.24.0", copies: [
    { from: "dist/preact.mjs", to: "preact/preact.js" },
    { from: "hooks/dist/hooks.mjs", to: "preact/hooks.js" },
  ] },
  { pkg: "htm", version: "3.1.1", copies: [
    { from: "dist/htm.mjs", to: "htm/htm.js" },
  ] },
  { pkg: "marked", version: "14.1.4", copies: [
    { from: "lib/marked.esm.js", to: "marked/marked.js" },
  ] },
];

function vendorOne(work, lib) {
  const spec = `${lib.pkg}@${lib.version}`;
  // `npm pack` writes the tarball into --pack-destination and prints its name.
  execFileSync("npm", ["pack", spec, "--pack-destination", work, "--silent"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error(`vendor-dashboard-libs: npm pack ${spec} produced no tarball in ${work}`);
  const ext = join(work, `ext-${lib.pkg}`);
  mkdirSync(ext, { recursive: true });
  // Every npm tarball extracts under a top-level `package/` directory.
  execFileSync("tar", ["-xzf", join(work, tgz), "-C", ext], { stdio: "inherit" });
  rmSync(join(work, tgz), { force: true });
  for (const { from, to } of lib.copies) {
    const src = join(ext, "package", from);
    const dest = join(VENDOR_DIR, to);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    console.log(`vendored ${spec}: ${from} -> dashboard/client/vendor/${to}`);
  }
}

function main() {
  // Rebuild the vendor tree from scratch so a removed/renamed dist file cannot
  // leave a stale vendored copy behind.
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "forge-vendor-"));
  try {
    for (const lib of LIBS) vendorOne(work, lib);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log("vendor-dashboard-libs: done.");
}

main();

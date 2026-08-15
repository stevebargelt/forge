// FG-643 — SOURCE GUARD. Fails if a new direct `marked` -> dangerouslySetInnerHTML
// path is introduced anywhere in dashboard/client/** outside the sanitizing
// boundary (markdown.js). This is a static check over the client source, not a
// runtime test: it defends the invariant that ALL rendered Markdown is
// sanitized, which a single new `marked.parse(...)` call could silently break.
//
// The rules:
//   R1  Only markdown.js may reference `marked` (import or call). It is the one
//       place parsing happens; its output is always passed to sanitizeHtml.
//   R2  Every `dangerouslySetInnerHTML` __html value in client/** must be fed by
//       md(...) or mdInline(...) (i.e. the sanitized boundary) — no other
//       expression is allowed as the HTML source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_DIR = fileURLToPath(new URL("../client", import.meta.url));
const SANITIZER_BOUNDARY = "markdown.js"; // the only module allowed to touch marked

function clientJsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "vendor") continue; // third-party vendored ESM is out of scope
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...clientJsFiles(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
}

const FILES = clientJsFiles(CLIENT_DIR);

test("source guard sees the client tree", () => {
  assert.ok(FILES.length > 0, "expected to find client .js files");
});

test("R1: only markdown.js references `marked`", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const base = file.split("/").pop()!;
    if (base === SANITIZER_BOUNDARY) continue;
    const src = readFileSync(file, "utf8");
    // Any import of the `marked` module, or a `marked.` member call.
    if (/from\s+["']marked["']/.test(src) || /\bmarked\s*\./.test(src)) {
      offenders.push(relative(CLIENT_DIR, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these client files call marked directly instead of going through ${SANITIZER_BOUNDARY}: ${offenders.join(", ")}`
  );
});

test("R2: every dangerouslySetInnerHTML __html is fed by md()/mdInline()", () => {
  // Match `dangerouslySetInnerHTML=${{ __html: <EXPR> }}` and inspect <EXPR>.
  const re = /dangerouslySetInnerHTML\s*=\s*\$\{\{\s*__html:\s*([^}]*)\}\}/g;
  const offenders: string[] = [];
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const expr = (m[1] ?? "").trim();
      // Allowed: md(...) or mdInline(...) as the source expression.
      if (!/^(md|mdInline)\s*\(/.test(expr)) {
        offenders.push(`${relative(CLIENT_DIR, file)}: ${expr}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these dangerouslySetInnerHTML sinks are not fed by the sanitizing md()/mdInline() boundary:\n${offenders.join("\n")}`
  );
});

test("R2b: the client actually has sanitized sinks (guard is not vacuous)", () => {
  const total = FILES.reduce((n, f) => {
    const src = readFileSync(f, "utf8");
    return n + (src.match(/dangerouslySetInnerHTML/g)?.length ?? 0);
  }, 0);
  assert.ok(total >= 4, `expected the known dangerouslySetInnerHTML sinks to be present, saw ${total}`);
});

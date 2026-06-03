// Skeleton BACKLOG.md tests.
//
// The skeleton is what `forge init` writes for a project with no backlog. It
// must (1) parse without throwing — the parser requires a `## Notes for next
// session` heading — (2) round-trip byte-for-byte through serialize, and
// (3) be immediately usable by `forge backlog` (an empty Active section).

import { test } from "node:test";
import assert from "node:assert/strict";
import { skeletonBacklogContent } from "./skeleton.js";
import { parseBacklog } from "./parse.js";
import { serializeBacklog } from "./serialize.js";

test("skeleton parses without throwing", () => {
  assert.doesNotThrow(() => parseBacklog(skeletonBacklogContent()));
});

test("skeleton round-trips byte-for-byte through parse → serialize", () => {
  const content = skeletonBacklogContent();
  assert.equal(serializeBacklog(parseBacklog(content)), content);
});

test("skeleton has the required preamble heading and Notes block", () => {
  const content = skeletonBacklogContent();
  assert.match(content, /^# forge — backlog/);
  assert.match(content, /## Notes for next session/);
});

test("skeleton renders an empty Active section with no tickets", () => {
  const b = parseBacklog(skeletonBacklogContent());
  assert.deepEqual(b.sections.get("Active"), []);
  assert.match(skeletonBacklogContent(), /## Active/);
});

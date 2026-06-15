---
id: FG-178
type: story
status: active
title: forge-test runs node:test and fails on Jest projects — agents must bypass with npx jest
---

**Bug:** the `forge-test` wrapper (mandated by every implementer + test-engineer seed) invokes Node's native test runner (`node:test`). On a project that uses Jest (e.g. web-admin, jest ^30) it fails outright — the agent can't validate via the sanctioned path.

**Evidence (2026-05-29):** test-engineer run `403d26` (run-add-sport-toggle-to-preview), notes verbatim: *"forge-test runs Node's native test runner which fails because the project uses Jest (jest ^30). Tests were verified by running 'npx jest --testPathPatterns=DisplayPreview.test --no-coverage' directly in web-admin/."* The agent bypassed forge-test to validate at all.

**Why it matters:** the seeds make forge-test the required validation gate ("use the forge-test wrapper, not npm test directly"). When forge-test breaks on Jest, a diligent agent bypasses it (as 403d26 did) but a less careful one reports a false `status: failed` or — worse — skips validation and returns `complete` unvalidated. Either way the gate is unreliable for the large class of Jest projects.

**Fix direction:** forge-test should detect the project's test runner (package.json `scripts.test` / devDeps: jest / vitest / node:test) and dispatch accordingly inside the container scratch copy, rather than hardcoding `node:test`. It already does the native-module rebuild + scratch-copy dance; it just needs runner detection. Keep the single `forge-test` entrypoint the seeds reference.

**Relation:** distinct from #125 (which is "implementer seeds don't *mention* forge-test"). Here forge-test IS used and picks the wrong runner. #125 is documentation; this is forge-test's runner assumption.
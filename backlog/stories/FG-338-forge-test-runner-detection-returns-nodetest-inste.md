---
id: FG-338
type: story
status: active
title: forge-test runner detection returns node:test instead of jest/vitest (FG-178 regression, 4 red tests on main)
created: 2026-06-20
---

**Found:** 2026-06-20 while running the full suite on the host to verify FG-190. Pre-existing — fails on clean `main`, unrelated to the change under test.

**Symptom:** 4 red tests in `src/v2/forge-test-detect-runner.test.ts`:
- `FG-178: devDependencies jest -> jest`
- `FG-178: devDependencies vitest -> vitest`
- `FG-178: scripts.test containing 'jest' -> jest (scripts pattern takes priority)`
- `FG-178: scripts.test pattern beats devDependencies (jest script wins over vitest dep)`

All four assert a runner is detected (jest/vitest) but the detector returns `node:test`. Example: `forge-test-detect-runner.test.ts:46` expects `'jest'`, actual `'node:test'`. The plain-node:test and missing-package.json cases still pass — so detection works for the fallback but not for jest/vitest via devDependencies or scripts.

**Likely cause:** FG-178 ("forge-test detects jest/vitest instead of hardcoding node:test", shipped this session) landed with the tests but the detection logic either doesn't read devDependencies/scripts as the tests expect, or the tests fixture-mismatch the implementation. Tests appear to have been committed red.

**Scope:** small, isolated to the runner-detection function + its test. Either the detector or the test fixtures are wrong — diagnose which against the FG-178 intent (scripts.test pattern should take priority over devDependencies).

**Refinement (2026-06-20):** the 4 tests FAIL on the host (`npm test`) but PASS in the agent container (`forge-test`). So this is an environment-dependent discrepancy, not simply committed-red. The detector likely behaves differently based on something present in-container but absent on host (e.g. resolvability of the jest/vitest binary, or a path/cwd assumption). Reproduce on host first; the fix must make detection deterministic regardless of whether the runner is installed in the fixture's node_modules.

#!/usr/bin/env bash
# #299 smoke: forge-test runs a tsx/node:test project inside the agent container
# WITHOUT the agent installing tsx ad hoc, and fails loud when a project has no
# test runner.
#
# Evidence this guards (forge-site #12): agents invoked forge-test, the container
# path failed because tsx was missing, and they fell back to direct test runs —
# reintroducing the host/container native-module mismatch forge-test exists to
# avoid. tsx now ships in the image (#299) and forge-test drives the tsx CLI.
#
# Requires the agent image: ./docker/build.sh && ./scripts/forge-test-smoke.sh
set -euo pipefail

IMAGE="${FORGE_AGENT_IMAGE:-agent-dev-worker:latest}"
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

# A representative tsx-based project: node:test files run via the `tsx` CLI, with
# NO local tsx install — it must resolve the image's global tsx, not an ad hoc one.
cat > "$FIX/package.json" <<'JSON'
{ "name": "tsx-smoke", "version": "1.0.0", "private": true, "type": "module",
  "scripts": { "test": "tsx --test app.test.ts" } }
JSON
cat > "$FIX/app.test.ts" <<'TS'
import { test } from "node:test";
import assert from "node:assert/strict";
const greet = (n: string): string => `hi ${n}`;
test("greet", () => { assert.equal(greet("forge"), "hi forge"); });
TS

run_ft() { # args → forge-test args; prints output, returns forge-test's exit code
  docker run --rm --user 1000 -e FORGE_NO_BROWSER=1 -v "$FIX:/project:rw" \
    --entrypoint forge-test "$IMAGE" "$@" 2>&1
}

fail=0

echo "=== Case 1: forge-test (no args → project npm test, tsx from PATH) ==="
if out=$(run_ft); then
  echo "$out" | grep -qE "# pass 1" && echo "PASS: npm-test path ran via global tsx" \
    || { echo "FAIL: expected '# pass 1'"; echo "$out"; fail=1; }
else
  echo "FAIL: forge-test (no args) exited non-zero"; echo "$out"; fail=1
fi

echo "=== Case 2: forge-test app.test.ts (file args → tsx CLI directly) ==="
if out=$(run_ft app.test.ts); then
  echo "$out" | grep -qE "# pass 1" && echo "PASS: file-args path ran via tsx CLI" \
    || { echo "FAIL: expected '# pass 1'"; echo "$out"; fail=1; }
else
  echo "FAIL: forge-test app.test.ts exited non-zero"; echo "$out"; fail=1
fi

echo "=== Case 3: project with no test runner → fail loud, useful diagnostic ==="
echo '{ "name": "no-runner", "version": "1.0.0", "private": true }' > "$FIX/package.json"
if out=$(run_ft); then
  echo "FAIL: expected non-zero exit for a project with no test script"; echo "$out"; fail=1
else
  echo "$out" | grep -qE "no \"test\" script" && echo "PASS: failed loud with a useful diagnostic" \
    || { echo "FAIL: missing useful diagnostic"; echo "$out"; fail=1; }
fi

echo "=== Case 4: a NON-forge project with its own src/test-setup.ts is NOT preloaded ==="
# src/test-setup.ts is a common filename; forge-test must only preload it in the
# forge repo (package.json name == forge), never a stranger's.
FIX2="$(mktemp -d)"; trap 'rm -rf "$FIX" "$FIX2"' EXIT
mkdir -p "$FIX2/src"
echo '{ "name": "stranger-app", "version": "1.0.0", "private": true, "type": "module" }' > "$FIX2/package.json"
echo 'console.error("STRANGER-SETUP-LOADED");' > "$FIX2/src/test-setup.ts"
cat > "$FIX2/app.test.ts" <<'TS'
import { test } from "node:test";
import assert from "node:assert/strict";
test("ok", () => { assert.equal(1, 1); });
TS
out=$(docker run --rm --user 1000 -e FORGE_NO_BROWSER=1 -v "$FIX2:/project:rw" --entrypoint forge-test "$IMAGE" app.test.ts 2>&1 || true)
if echo "$out" | grep -qE "# pass 1" && ! echo "$out" | grep -q "STRANGER-SETUP-LOADED"; then
  echo "PASS: stranger's src/test-setup.ts was NOT preloaded"
else
  echo "FAIL: a non-forge src/test-setup.ts leaked into the run (or the test didn't run)"; echo "$out"; fail=1
fi

echo "=== Case 5: the forge repo (package.json name == forge) DOES preload src/test-setup.ts ==="
FIX3="$(mktemp -d)"; trap 'rm -rf "$FIX" "$FIX2" "$FIX3"' EXIT
mkdir -p "$FIX3/src"
echo '{ "name": "forge", "version": "0.1.0", "private": true, "type": "module" }' > "$FIX3/package.json"
echo 'console.error("FORGE-SETUP-LOADED");' > "$FIX3/src/test-setup.ts"
cat > "$FIX3/app.test.ts" <<'TS'
import { test } from "node:test";
import assert from "node:assert/strict";
test("ok", () => { assert.equal(1, 1); });
TS
out=$(docker run --rm --user 1000 -e FORGE_NO_BROWSER=1 -v "$FIX3:/project:rw" --entrypoint forge-test "$IMAGE" app.test.ts 2>&1 || true)
if echo "$out" | grep -qE "# pass 1" && echo "$out" | grep -q "FORGE-SETUP-LOADED"; then
  echo "PASS: forge repo's src/test-setup.ts was preloaded (gate matches the forge repo)"
else
  echo "FAIL: forge repo's src/test-setup.ts was NOT preloaded"; echo "$out"; fail=1
fi

[ "$fail" = "0" ] && echo "ALL PASS: forge-test serves tsx projects without ad hoc globals (#299)." || { echo "SMOKE FAILED"; exit 1; }

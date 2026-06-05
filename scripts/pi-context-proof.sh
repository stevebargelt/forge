#!/usr/bin/env bash
# #263 — prove the pi-apikey prompt strategy delivers forge context EXACTLY ONCE.
#
# The pi-apikey runtime (seeds/runtimes/pi-apikey.yml) injects forge's composed
# system prompt via `--append-system-prompt`, the task package as a positional
# message, and sets `--no-context-files` so pi does NOT also auto-load the
# project's CLAUDE.md/AGENTS.md (a second, leaked context source).
#
# This harness validates that claim against the REAL pi binary in the agent image,
# deterministically and offline: it points pi at a local mock endpoint (via a
# custom models.json provider) and inspects the actual outbound request body. No
# provider credential, no network, no token spend.
#
# Asserts, with forge's flags (--no-context-files):
#   - the system-prompt sentinel appears exactly once  (seed+constraints, once)
#   - the task sentinel appears exactly once            (task package, once)
#   - the project-context-file sentinel does NOT appear (no double-load)
# and as a control (without --no-context-files) the project file IS loaded —
# proving the flag is what suppresses it.
#
# Re-run after bumping pi (PI_CLI_VERSION in docker/agent-dev-worker.Dockerfile)
# to confirm --no-context-files semantics still hold. Requires the agent image:
#   ./docker/build.sh && ./scripts/pi-context-proof.sh
set -euo pipefail

IMAGE="${FORGE_AGENT_IMAGE:-agent-dev-worker:latest}"
H="$(mktemp -d)"
trap 'rm -rf "$H"' EXIT

cat > "$H/mock.js" <<'JS'
// Records every request body to /tmp/reqs.log; returns a minimal anthropic reply.
const http = require("http"), fs = require("fs");
http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => {
    fs.appendFileSync("/tmp/reqs.log", b + "\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_x", type: "message", role: "assistant", model: "mock",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}).listen(8899, "127.0.0.1", () => console.error("mock up"));
JS

cat > "$H/harness.sh" <<'SH'
set -e
SYS=SENTINEL_SYS_MARKER_42; TASK=SENTINEL_TASK_MARKER_99
# pi's resource-loader recognizes BOTH AGENTS.md and CLAUDE.md (per directory it
# loads the first candidate). Each gets its own sentinel so the proof catches a
# regression where pi keeps suppressing one but starts loading the other.
CLA=SENTINEL_CLAUDE_MARKER_7; AGE=SENTINEL_AGENTS_MARKER_8
mkdir -p ~/.pi/agent ~/proj
# Custom provider pointing pi at the local mock (the #268 models.json mechanism,
# used here only as a test seam — NOT forge's runtime path).
cat > ~/.pi/agent/models.json <<JSON
{"providers":{"mock":{"baseUrl":"http://127.0.0.1:8899","apiKey":"dummy","api":"anthropic-messages","models":[{"id":"mock-model"}]}}}
JSON
cd ~/proj
node /h/mock.js & sleep 1

# Reset the project's context files to exactly the named set (claude / agents).
seed_files(){ rm -f ~/proj/CLAUDE.md ~/proj/AGENTS.md
  for f in "$@"; do case $f in
    claude) printf 'PROJECT CLAUDE\n%s\n' "$CLA" > ~/proj/CLAUDE.md;;
    agents) printf 'PROJECT AGENTS\n%s\n' "$AGE" > ~/proj/AGENTS.md;;
  esac; done; }
run_pi(){ pi -p --mode json --no-session --provider mock --model mock-model \
  "$@" --append-system-prompt "$SYS" "$TASK" >/dev/null 2>&1 || true; }
n(){ grep -oh "$1" /tmp/reqs.log 2>/dev/null | wc -l | tr -d ' '; }

# Treatment: BOTH context files present + forge's flag → both must be suppressed.
seed_files claude agents; : > /tmp/reqs.log; run_pi --no-context-files
T_SYS=$(n "$SYS"); T_TASK=$(n "$TASK"); T_CLA=$(n "$CLA"); T_AGE=$(n "$AGE")
echo "with --no-context-files (both files present): sys=$T_SYS task=$T_TASK claude=$T_CLA agents=$T_AGE"

# Controls: each file ALONE, no flag → it must load (isolated because pi loads
# only the first context candidate per directory).
seed_files claude; : > /tmp/reqs.log; run_pi; C_CLA=$(n "$CLA")
seed_files agents; : > /tmp/reqs.log; run_pi; C_AGE=$(n "$AGE")
echo "without --no-context-files (controls): claude=$C_CLA agents=$C_AGE"

fail=0
[ "$T_SYS" = "1" ]   || { echo "FAIL: seed+constraints not delivered exactly once (got $T_SYS)"; fail=1; }
[ "$T_TASK" = "1" ]  || { echo "FAIL: task package not delivered exactly once (got $T_TASK)"; fail=1; }
[ "$T_CLA" = "0" ]   || { echo "FAIL: project CLAUDE.md leaked despite --no-context-files (got $T_CLA)"; fail=1; }
[ "$T_AGE" = "0" ]   || { echo "FAIL: project AGENTS.md leaked despite --no-context-files (got $T_AGE)"; fail=1; }
[ "$C_CLA" -ge "1" ] || { echo "FAIL: control did not load CLAUDE.md — flag proof inconclusive (got $C_CLA)"; fail=1; }
[ "$C_AGE" -ge "1" ] || { echo "FAIL: control did not load AGENTS.md — flag proof inconclusive (got $C_AGE)"; fail=1; }
[ "$fail" = "0" ] && echo "PASS: forge context delivered exactly once; --no-context-files suppresses both CLAUDE.md and AGENTS.md." || exit 1
SH

docker run --rm --user 1000 -e FORGE_NO_BROWSER=1 -v "$H:/h:ro" --entrypoint bash "$IMAGE" /h/harness.sh

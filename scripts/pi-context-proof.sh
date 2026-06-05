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
SYS=SENTINEL_SYS_MARKER_42; TASK=SENTINEL_TASK_MARKER_99; CTX=SENTINEL_CTXFILE_MARKER_7
mkdir -p ~/.pi/agent ~/proj
# Custom provider pointing pi at the local mock (the #268 models.json mechanism,
# used here only as a test seam — NOT forge's runtime path).
cat > ~/.pi/agent/models.json <<JSON
{"providers":{"mock":{"baseUrl":"http://127.0.0.1:8899","apiKey":"dummy","api":"anthropic-messages","models":[{"id":"mock-model"}]}}}
JSON
printf 'PROJECT CONTEXT\n%s\n' "$CTX" > ~/proj/CLAUDE.md
cd ~/proj
node /h/mock.js & sleep 1

run_pi(){ pi -p --mode json --no-session --provider mock --model mock-model \
  "$@" --append-system-prompt "$SYS" "$TASK" >/dev/null 2>&1 || true; }
n(){ grep -oh "$1" /tmp/reqs.log 2>/dev/null | wc -l | tr -d ' '; }

# Forge's real flags.
: > /tmp/reqs.log
run_pi --no-context-files
A_SYS=$(n "$SYS"); A_TASK=$(n "$TASK"); A_CTX=$(n "$CTX")
echo "with --no-context-files: sys=$A_SYS task=$A_TASK ctxfile=$A_CTX"

# Control: drop the flag; the project CLAUDE.md should now leak in.
: > /tmp/reqs.log
run_pi
B_CTX=$(n "$CTX")
echo "without --no-context-files (control): ctxfile=$B_CTX"

fail=0
[ "$A_SYS" = "1" ]  || { echo "FAIL: seed+constraints not delivered exactly once (got $A_SYS)"; fail=1; }
[ "$A_TASK" = "1" ] || { echo "FAIL: task package not delivered exactly once (got $A_TASK)"; fail=1; }
[ "$A_CTX" = "0" ]  || { echo "FAIL: project context file leaked despite --no-context-files (got $A_CTX)"; fail=1; }
[ "$B_CTX" -ge "1" ] || { echo "FAIL: control did not load the project file — flag proof inconclusive (got $B_CTX)"; fail=1; }
[ "$fail" = "0" ] && echo "PASS: forge context delivered exactly once; --no-context-files is load-bearing." || exit 1
SH

docker run --rm --user 1000 -e FORGE_NO_BROWSER=1 -v "$H:/h:ro" --entrypoint bash "$IMAGE" /h/harness.sh

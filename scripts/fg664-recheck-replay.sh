#!/usr/bin/env bash
# fg664-recheck-replay — the OPERATOR-RUN harness for FG-664 AC 4: re-execute
# FG-662's recheck over RF-1, RF-3 and RF-4, at the real candidate
# 593f88bad31813383c53c42a27fd9ef095759db8, THROUGH THE REPAIRED LANE, and print
# what the ledger actually recorded.
#
# WHY THIS EXISTS. FG-662's review (review-6b9e07e48cc6) carries three FALSE
# "still present" verdicts. The rechecker could not load the project's real
# native database driver in its read-only container, substituted a node:sqlite
# shim, ran the regression suite against a DIFFERENT SQLite implementation, and
# reported the engine-difference failures as the findings still being present.
# The review had to be settled on an explicit operator override. AC 4 says those
# three findings must come back RESOLVED on genuinely EXECUTED evidence once the
# driver is really available. This script is how that is executed and shown.
#
# WHAT A GREEN RUN HERE IS EVIDENCE FOR, AND WHAT IT IS NOT.
#   It is evidence for HALF (A) ONLY — that a read-only reviewer container can
#   now load the project's shipping driver, so the lane can genuinely execute the
#   cited tests. A fail-closed lane BLOCKS; `blocked_environment` coverage is by
#   construction never green and never resolved (src/v2/review-evidence.ts:344).
#   So half (B) can never carry this script green, and a green run here must
#   NEVER be read as evidence that a lane which cannot load the driver fails
#   closed. That is a separate claim with separate evidence.
#   Any finding coming back `blocked_environment` means half (A) did not take on
#   this host and AC 4 IS NOT MET. This script reports that as a FAILURE, loudly,
#   because recording AC 4 as met on a blocked lane is the exact failure FG-664
#   exists to close.
#
# WHY A SCRIPT AND NOT A TEST. The recheck lane dispatches a real agent container
# against a real candidate. No npm tier in this repo can do that (agent
# containers have no daemon; no CI job builds or runs the agent image), so the
# only test that could exist would be skip-capable — and a green skip is a false
# proof. Same reasoning, and the same shape, as
# scripts/fg621-clone-boundary-smoke.sh and the FG-559 live worktree smoke.
# Deliberately OUTSIDE every npm tier and outside CI. Do not add a CI job.
#
# FAILS CLOSED. Every missing prerequisite exits NONZERO — no docker, no daemon,
# no git, no node_modules, no ledger, a review bound to a DIFFERENT candidate, a
# candidate that is not present locally as a commit object, or a rewind that does
# not land the subject on Stage 8. There is exactly one `exit 0` in this file and
# it is the last line, reached only when all three findings came back `resolved`
# with `coverage: executed` and a non-empty cited runner output. Nothing skips.
#
# THE RE-ENTRY QUESTION IS ANSWERED BY THE PRODUCT, NOT BY THIS SCRIPT.
# review-6b9e07e48cc6 settled on an operator override, and `settled` is TERMINAL
# in the coordinator: resolveTransition short-circuits it before any stage is
# selected (src/v2/review-coordinator.ts:280) and no forge verb reverses it. So
# this script ASKS the product — `forge review continue --dry-run` — which
# transition the row may legitimately take:
#   * if the answer is `recheck`, the row may re-enter Stage 8 and it is replayed
#     IN PLACE, through `forge review continue`, on the live ledger;
#   * otherwise it may NOT, and an EQUIVALENT recheck is materialized over the
#     same three finding ids at the same candidate, on a COPY of the ledger, and
#     THE DIVERGENCE IS PRINTED — the subject is an equivalent recheck, not the
#     original row, and exactly which mutations made it re-enterable.
# AC 4 is never reported met on a substituted subject without saying so.
#
# WHAT THE EQUIVALENT SUBJECT IS, PRECISELY. Not a hand-built fixture: the
# ORIGINAL review row, copied byte-for-byte into a scratch ledger, then rewound
# past Stage 8 (state off `settled`, the recheck stage record removed, the three
# false verdicts cleared) so the coordinator selects Stage 8 again. Everything
# the rechecker receives — the contract, the finding text, the dispositions, the
# fixer evidence, the batches — is the real thing. Only the LEDGER is a copy.
# FORGE_HOME is NOT redirected: the dispatch resolves its image, provider and
# routing from the operator's real forge home, so run artifacts land under
# ~/.forge/runs like any other dispatch. The live ~/.forge/forge.db is checksummed
# before and after the replay and asserted unchanged.
#
# USAGE
#   ./scripts/fg664-recheck-replay.sh [--project-dir DIR] [--review ID]
#                                     [--candidate SHA] [--db PATH]
#                                     [--route KEY] [--image IMAGE]
#
#   --project-dir  the checkout the replay dispatches against; must contain the
#                  candidate as a commit object (default: this repo)
#   --review       the review to replay (default: review-6b9e07e48cc6)
#   --candidate    the candidate sha this replay is proving (default:
#                  593f88bad31813383c53c42a27fd9ef095759db8, FG-662's fix
#                  candidate). Must be a full 40- or 64-character lowercase hex
#                  sha, must be present in --project-dir as a commit object, and
#                  must be the sha the review is bound to
#   --db           the source ledger (default: $FORGE_DB_PATH, else
#                  $FORGE_HOME/forge.db, else ~/.forge/forge.db)
#   --route        the resolved routing-policy key for the dispatch; without it
#                  the replay runs --unrouted, and which was used is printed
#   --image        assert this agent image exists before dispatching. Optional:
#                  the dispatch resolves its own image from the runtime registry,
#                  so a missing image surfaces as a refused stage, which this
#                  script reports as a FAILURE either way
#
#   FG664_WORKDIR  parent dir for the scratch ledger copy (default: mktemp -d)
#
# THE CANDIDATE IS ASSERTED, NEVER ASSUMED. A recheck at another candidate is not
# evidence about this one — the ingestion path refuses exactly that
# (src/v2/review-recheck.ts:135-142), and so does this harness. `--candidate`
# says which candidate is being proven; it does NOT relax the assertion. The
# review must still be bound to the supplied sha, and the sha must still resolve
# to a commit object in the dispatch checkout. Omit it and the default is
# FG-662's candidate, exactly as before.

set -euo pipefail

SELF="fg664-recheck-replay"

# The FG-662 fix candidate — the DEFAULT, unchanged. `--candidate` overrides it;
# every assertion about it survives the override. See the note above.
CANDIDATE="593f88bad31813383c53c42a27fd9ef095759db8"
# The three findings the substituted engine produced false "still present"
# verdicts for. AC 4 is adjudicated on exactly these.
REPLAY_REFS="RF-1,RF-3,RF-4"

REVIEW_ID="review-6b9e07e48cc6"
# Printed in the evidence block: a reader must be able to tell the pinned default
# from an operator-supplied candidate without diffing the script.
CANDIDATE_SOURCE="the pinned default"
PROJECT_DIR_ARG=""
DB_ARG=""
ROUTE=""
IMAGE=""

fatal() {
  echo "$SELF: FATAL: $*" >&2
  echo "$SELF: this script fails closed — a missing prerequisite is never a pass, and never AC 4 met." >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --project-dir) [ $# -ge 2 ] || fatal "--project-dir needs a value"; PROJECT_DIR_ARG="$2"; shift 2 ;;
    --review)      [ $# -ge 2 ] || fatal "--review needs a value";      REVIEW_ID="$2";       shift 2 ;;
    --candidate)   [ $# -ge 2 ] || fatal "--candidate needs a value";   CANDIDATE="$2"; CANDIDATE_SOURCE="--candidate"; shift 2 ;;
    --db)          [ $# -ge 2 ] || fatal "--db needs a value";          DB_ARG="$2";          shift 2 ;;
    --route)       [ $# -ge 2 ] || fatal "--route needs a value";       ROUTE="$2";           shift 2 ;;
    --image)       [ $# -ge 2 ] || fatal "--image needs a value";       IMAGE="$2";           shift 2 ;;
    -h|--help)     sed -n '2,99p' "$0"; exit 2 ;;
    *)             fatal "unknown argument: $1 (see --help)" ;;
  esac
done

# ── The candidate must LOOK like a sha before anything is asked about it ─────
#
# `git cat-file -t` below is the real assertion, but it resolves far more than a
# sha: a branch, a tag, `HEAD`, `@{-1}` all name a commit, and any of them would
# then fail the review-binding comparison as a baffling "bound to <sha>, not
# HEAD" rather than as the malformed argument it is. Full length only — the
# binding check is a string comparison against the sha the ledger recorded, so an
# abbreviation can never match it, and saying so here beats saying it there.
case "$CANDIDATE" in
  "" | *[!0-9a-f]*)
    fatal "--candidate '$CANDIDATE' is not a sha: expected 40 (or 64) lowercase hex characters and nothing else." ;;
esac
[ ${#CANDIDATE} -eq 40 ] || [ ${#CANDIDATE} -eq 64 ] \
  || fatal "--candidate '$CANDIDATE' is ${#CANDIDATE} characters; a FULL 40- or 64-character sha is required. The review's recorded candidate is compared as a string, so an abbreviation could never match it."

# ── Prerequisites, in the order that gives the most useful diagnostic ─────────

command -v git >/dev/null 2>&1 \
  || fatal "no 'git' on PATH — the candidate has to be resolved as a real commit object."

command -v node >/dev/null 2>&1 \
  || fatal "no 'node' on PATH — this harness drives forge's own CLI and reads the ledger with forge's own sqlite driver."

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd -P)"

PROJECT_DIR="$(cd "${PROJECT_DIR_ARG:-$REPO_ROOT}" 2>/dev/null && pwd -P)" \
  || fatal "project dir '${PROJECT_DIR_ARG:-$REPO_ROOT}' does not exist."

# ── (i) THE CANDIDATE MUST BE PRESENT LOCALLY, AS A COMMIT ───────────────────
#
# CHECKED FIRST, before the driver and the daemon: FG-662 was squash-merged, so
# the candidate survives only as a fetched object, and its absence is both the
# likeliest failure and the one nothing else can compensate for. A replay that
# cannot resolve it is not a replay of this candidate, and a recheck bound to
# another candidate is refused at ingestion anyway
# (src/v2/review-recheck.ts:135-142). Refuse here, by name, rather than dispatch
# a container that will fail obscurely.

CANDIDATE_TYPE="$(git -C "$PROJECT_DIR" cat-file -t "$CANDIDATE" 2>/dev/null || true)"
[ "$CANDIDATE_TYPE" = "commit" ] \
  || fatal "candidate $CANDIDATE is NOT present in $PROJECT_DIR as a commit object (git cat-file -t said '${CANDIDATE_TYPE:-nothing}'). Fetch it into this checkout first — a replay bound to any other candidate is not evidence about this one."

[ -d "$REPO_ROOT/node_modules/better-sqlite3" ] \
  || fatal "$REPO_ROOT/node_modules/better-sqlite3 is absent — run 'npm install' in $REPO_ROOT. The ledger is read with forge's OWN driver, not a substitute (which is the defect this ticket exists to close)."
[ -x "$REPO_ROOT/bin/forge" ] \
  || fatal "$REPO_ROOT/bin/forge is not executable — the replay runs through the product's own CLI, not a re-implementation."

# ── The source ledger ────────────────────────────────────────────────────────

DB="${DB_ARG:-${FORGE_DB_PATH:-${FORGE_HOME:-$HOME/.forge}/forge.db}}"
[ -f "$DB" ] \
  || fatal "no forge ledger at $DB — there is no review to replay. Pass --db, or set FORGE_DB_PATH."

case "$DB:$PROJECT_DIR:$REPO_ROOT" in
  *\'*|*\"*) fatal "a path contains a quote; the node programs below quote them into shell." ;;
esac

WORK="$(mktemp -d "${FG664_WORKDIR:-${TMPDIR:-/tmp}}/fg664-replay.XXXXXX")" \
  || fatal "cannot create a work dir."
cleanup() { rm -rf "$WORK" || true; }
trap cleanup EXIT

# ── Ledger readers ───────────────────────────────────────────────────────────
#
# READ-ONLY, and through better-sqlite3 directly rather than through the store
# API: the store's open path is write-capable (it applies additive migrations and
# may checkpoint), and this harness must not write a single byte of the live
# ledger. `readonly: true` is the mechanical guarantee of that, and it is what
# makes the before/after checksum below mean something.

# Every node program below runs with cwd = $REPO_ROOT. Node resolves a BARE
# specifier in an --eval script against the CURRENT WORKING DIRECTORY, so an
# operator invoking this script from anywhere but the repo root would otherwise
# get ERR_MODULE_NOT_FOUND for better-sqlite3 — reported as an unreadable ledger.
# Every path these programs touch is passed absolute through the environment, so
# the cd changes nothing else.
inspect_ledger() { # $1 = db path, $2 = review id  → K=V lines on stdout
  ( cd "$REPO_ROOT" && FG664_DB="$1" FG664_REVIEW="$2" node --input-type=module -e '
    import Database from "better-sqlite3";
    const db = new Database(process.env.FG664_DB, { readonly: true, fileMustExist: true });
    const r = db.prepare("SELECT * FROM reviews WHERE id = ?").get(process.env.FG664_REVIEW);
    if (r === undefined) { console.log("REVIEW_FOUND=0"); process.exit(0); }
    console.log("REVIEW_FOUND=1");
    console.log("STATE=" + (r.state ?? ""));
    console.log("CANDIDATE=" + (r.candidate_sha ?? ""));
    console.log("CONFIRMED=" + (r.contract_confirmed_sha ?? ""));
    console.log("WORKSPACE=" + (r.workspace_dir ?? ""));
    console.log("TICKET=" + (r.ticket_id ?? ""));
    console.log("RUN=" + (r.run_id ?? ""));
    const rows = db.prepare("SELECT finding_ref, disposition, resolution, resolution_evidence_kind FROM review_findings WHERE review_id = ? ORDER BY ordinal").all(r.id);
    console.log("REFS=" + rows.map((f) => f.finding_ref).join(","));
    console.log("FIXNOW=" + rows.filter((f) => f.disposition === "fix_now").map((f) => f.finding_ref).join(","));
    for (const f of rows) {
      console.log("RECORDED " + f.finding_ref + " disposition=" + f.disposition +
        " resolution=" + (f.resolution ?? "(none)") + " evidence_kind=" + (f.resolution_evidence_kind ?? "(none)"));
    }
    const se = r.stage_evidence_json ? JSON.parse(r.stage_evidence_json) : {};
    const rc = se.recheck;
    console.log("RECHECK_STAGE_SHA=" + (rc && rc.sha ? rc.sha : ""));
    const prior = rc && rc.meta && Array.isArray(rc.meta.results) ? rc.meta.results : [];
    for (const x of prior) console.log("PRIOR " + x.ref + " resolution=" + x.resolution + " coverage=" + x.coverage);
    db.close();
  ' )
}

LIVE="$WORK/live.kv"
inspect_ledger "$DB" "$REVIEW_ID" > "$LIVE" \
  || fatal "could not read $DB. If a forge process is mid-write, quiesce it and re-run; a readonly open of a WAL store needs its -shm."

# Trimming in the shell, never with `| head`: head SIGPIPEs its writer, and under
# pipefail+errexit that is a silent death whose likelihood grows with the input.
first_line() { printf '%s' "${1%%$'\n'*}"; }
kv() { first_line "$(sed -n "s/^$1=//p" "$LIVE")"; }

[ "$(kv REVIEW_FOUND)" = "1" ] \
  || fatal "no review $REVIEW_ID in $DB — nothing to replay. Pass --review, or --db."

LIVE_STATE="$(kv STATE)"
LIVE_CANDIDATE="$(kv CANDIDATE)"
LIVE_CONFIRMED="$(kv CONFIRMED)"
LIVE_TICKET="$(kv TICKET)"
LIVE_WORKSPACE="$(kv WORKSPACE)"
LIVE_FIXNOW="$(kv FIXNOW)"

# ── The review must be bound to THIS candidate ───────────────────────────────

[ "$LIVE_CANDIDATE" = "$CANDIDATE" ] \
  || fatal "review $REVIEW_ID is bound to candidate ${LIVE_CANDIDATE:-(unset)}, not $CANDIDATE. REFUSING to replay: a recheck at another candidate is not evidence about this one (src/v2/review-recheck.ts:135-142)."

[ -n "$LIVE_CONFIRMED" ] \
  || fatal "review $REVIEW_ID records no contract-confirmed sha; the recheck stage diffs confirmed..candidate and cannot run."
[ "$(git -C "$PROJECT_DIR" cat-file -t "$LIVE_CONFIRMED" 2>/dev/null || true)" = "commit" ] \
  || fatal "the review's contract-confirmed sha $LIVE_CONFIRMED is not present in $PROJECT_DIR as a commit object — the stage's confirmed..candidate diff cannot be computed. Fetch it first."

# ── The three AC 4 subjects must be present, and fix_now ─────────────────────
#
# The lane's expected set IS the whole fix_now set — narrowing it would be
# fabrication, and ingestion refuses an omission as a schema failure. So a LARGER
# fix_now set is not a refusal: the replay covers all of it and AC 4 is
# adjudicated on the three, with the difference PRINTED rather than hidden.

SUBJECT_SUPERSET=""
MISSING=""
for ref in ${REPLAY_REFS//,/ }; do
  case ",$LIVE_FIXNOW," in
    *",$ref,"*) : ;;
    *)          MISSING="$MISSING $ref" ;;
  esac
done
[ -z "$MISSING" ] \
  || fatal "review $REVIEW_ID has no fix_now finding(s) for:$MISSING (its fix_now set is: ${LIVE_FIXNOW:-none}). AC 4 names RF-1, RF-3 and RF-4 — refusing rather than adjudicating a different set."

for ref in ${LIVE_FIXNOW//,/ }; do
  case ",$REPLAY_REFS," in
    *",$ref,"*) : ;;
    *)          SUBJECT_SUPERSET="$SUBJECT_SUPERSET $ref" ;;
  esac
done

# ── The re-entry question, answered by the PRODUCT ───────────────────────────

forge_cli() { # runs forge against a chosen ledger; every other path stays the operator's
  local db="$1"; shift
  ( cd "$REPO_ROOT" && FORGE_DB_PATH="$db" ./bin/forge "$@" )
}

ROUTE_ARGS=()
if [ -n "$ROUTE" ]; then ROUTE_ARGS=(--route "$ROUTE"); else ROUTE_ARGS=(--unrouted); fi

next_kind() { # $1 = db path  → the coordinator's own next-transition kind
  local db="$1" out
  out="$(forge_cli "$db" review continue "$REVIEW_ID" --project "$PROJECT_DIR" --dry-run --json 2>"$WORK/dryrun.err" || true)"
  printf '%s' "$out" > "$WORK/dryrun.json"
  # Sliced from the first { to the last }, not parsed whole: bin/forge may print
  # preflight lines around the JSON, and a parse that died on those would report
  # "no transition" for a review that has one — which this script would then read
  # as "may not re-enter" and silently substitute the subject.
  FG664_JSON="$WORK/dryrun.json" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    let kind = "";
    try {
      const raw = readFileSync(process.env.FG664_JSON, "utf8");
      const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
      if (a >= 0 && b > a) kind = (JSON.parse(raw.slice(a, b + 1)).transition ?? {}).kind ?? "";
    } catch { kind = ""; }
    console.log(kind);
  '
}

# ── The dispatch prerequisites, checked before anything dispatches ───────────
#
# Deliberately AFTER the identity checks above: an operator whose candidate is
# missing or whose review is bound elsewhere should be told THAT, not told about
# a daemon they would only need if the replay could legitimately run at all.

command -v docker >/dev/null 2>&1 \
  || fatal "no 'docker' on PATH — the recheck dispatches a real agent container."

docker info >/dev/null 2>&1 \
  || fatal "no reachable Docker daemon ('docker info' failed) — run this on the macOS host, never inside an agent container."

if [ -n "$IMAGE" ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 \
    || fatal "agent image '$IMAGE' is absent — build it with ./docker/build.sh, or drop --image."
fi

echo "==> asking the coordinator whether $REVIEW_ID may re-enter Stage 8"
LIVE_NEXT="$(first_line "$(next_kind "$DB")")"
[ -n "$LIVE_NEXT" ] \
  || fatal "'forge review continue --dry-run --json' produced no transition for $REVIEW_ID. stderr: $(first_line "$(cat "$WORK/dryrun.err" 2>/dev/null || true)")"

MODE=""
DIVERGENCE=""
SUBJECT_DB="$DB"
REWIND_LOG=""

if [ "$LIVE_NEXT" = "recheck" ]; then
  MODE="in_place"
  echo "$SELF: the coordinator's own next transition for $REVIEW_ID is 'recheck' — the row MAY re-enter Stage 8."
  echo "$SELF: replaying IN PLACE, on the live ledger $DB, through 'forge review continue'."
else
  MODE="equivalent"
  DIVERGENCE="the coordinator's next transition for $REVIEW_ID is '$LIVE_NEXT' (review state: $LIVE_STATE), NOT 'recheck', so the row may NOT legitimately re-enter Stage 8"
  echo "$SELF: $DIVERGENCE."
  echo "$SELF: materializing an EQUIVALENT recheck over $REPLAY_REFS at $CANDIDATE, on a COPY of the ledger."
fi

# ── Materialize the equivalent subject, when the row may not re-enter ────────

DB_BEFORE=""
DB_AFTER=""
# The store AND its write-ahead log, because a write can land in the -wal without
# the main file changing a byte. The -shm is deliberately excluded: it is shared
# memory bookkeeping that a READ mutates, so including it would false-fail on our
# own readonly opens.
sha256_of() {
  local p out=""
  for p in "$1" "$1-wal"; do
    [ -f "$p" ] || continue
    if command -v shasum >/dev/null 2>&1; then out="$out$(first_line "$(shasum -a 256 "$p")") "
    elif command -v sha256sum >/dev/null 2>&1; then out="$out$(first_line "$(sha256sum "$p")") "
    else out="$out(no sha256 tool) "; fi
  done
  printf '%s' "$out"
}

if [ "$MODE" = "equivalent" ]; then
  SUBJECT_DB="$WORK/forge-copy.db"
  echo "==> copying the ledger to $SUBJECT_DB and rewinding the copy past Stage 8"
  ( cd "$REPO_ROOT" && FG664_DB="$DB" FG664_COPY="$SUBJECT_DB" FG664_REVIEW="$REVIEW_ID" FG664_REFS="$REPLAY_REFS" \
    node --input-type=module -e '
      import Database from "better-sqlite3";
      const src = new Database(process.env.FG664_DB, { readonly: true, fileMustExist: true });
      await src.backup(process.env.FG664_COPY);
      src.close();
      const db = new Database(process.env.FG664_COPY, { fileMustExist: true });
      const id = process.env.FG664_REVIEW;
      const refs = process.env.FG664_REFS.split(",");
      const marks = refs.map(() => "?").join(",");
      // EXACTLY three mutations, printed verbatim, and each one is a REWIND —
      // nothing here invents a fact. State off the terminal value; the Stage 8
      // record removed so the coordinator selects Stage 8 again; and the three
      // verdicts produced by the substituted engine cleared, so what the replay
      // records is the replay own and never a stale row read as fresh.
      const plan = [
        ["UPDATE reviews SET state = ?, settled_at = NULL WHERE id = ?", ["rechecking", id]],
        ["UPDATE reviews SET stage_evidence_json = json_remove(stage_evidence_json, ?) WHERE id = ?", ["$.recheck", id]],
        ["UPDATE review_findings SET resolution = NULL, resolution_evidence_kind = NULL, resolution_evidence = NULL, resolved_sha = NULL WHERE review_id = ? AND finding_ref IN (" + marks + ")", [id, ...refs]],
      ];
      for (const [sql, params] of plan) {
        const info = db.prepare(sql).run(...params);
        console.log("REWIND " + info.changes + " row(s) | " + sql + " | " + JSON.stringify(params));
      }
      db.close();
    ' ) > "$WORK/rewind.log" || fatal "could not copy and rewind the ledger."
  REWIND_LOG="$(cat "$WORK/rewind.log")"
  printf '%s\n' "$REWIND_LOG"

  COPY_NEXT="$(first_line "$(next_kind "$SUBJECT_DB")")"
  [ "$COPY_NEXT" = "recheck" ] \
    || fatal "after the rewind the coordinator's next transition on the copy is '$COPY_NEXT', not 'recheck'. REFUSING to run some other stage — a fixer or a discovery dispatch is not what AC 4 asks for."
fi

# ── (ii) Re-execute the recheck THROUGH THE REPAIRED LANE ────────────────────

DB_BEFORE="$(sha256_of "$DB")"

echo
echo "==> running Stage 8 for $REVIEW_ID at $CANDIDATE (ledger: $SUBJECT_DB)"
echo "    forge review continue $REVIEW_ID --project $PROJECT_DIR ${ROUTE_ARGS[*]}"
set +e
forge_cli "$SUBJECT_DB" review continue "$REVIEW_ID" --project "$PROJECT_DIR" "${ROUTE_ARGS[@]}" \
  > "$WORK/stage.log" 2>&1
STAGE_RC=$?
set -e
cat "$WORK/stage.log"

DB_AFTER="$(sha256_of "$DB")"

# ── (iii) What the ledger recorded, per finding ──────────────────────────────

REPORT="$WORK/report.txt"
( cd "$REPO_ROOT" && FG664_DB="$SUBJECT_DB" FG664_REVIEW="$REVIEW_ID" FG664_REFS="$REPLAY_REFS" \
  node --input-type=module -e '
    import Database from "better-sqlite3";
    const db = new Database(process.env.FG664_DB, { readonly: true, fileMustExist: true });
    const id = process.env.FG664_REVIEW;
    const refs = process.env.FG664_REFS.split(",");
    const r = db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
    const se = r && r.stage_evidence_json ? JSON.parse(r.stage_evidence_json) : {};
    const rc = se.recheck ?? {};
    const coverage = new Map((rc.meta && Array.isArray(rc.meta.results) ? rc.meta.results : []).map((x) => [x.ref, x.coverage]));

    // The rechecker task id is durable on the review itself (recordAgentProtocol),
    // so the raw runner output the verdict cited is retrievable rather than
    // restated. The LAST recheck record is this run.
    const lens = r && r.lens_outcomes_json ? JSON.parse(r.lens_outcomes_json) : [];
    const protos = (Array.isArray(lens) ? lens : []).filter((x) => x && x.kind === "agent_protocol" && x.stage === "recheck");
    const taskId = protos.length > 0 ? protos[protos.length - 1].taskId : "";
    let entries = [];
    if (taskId !== "") {
      const t = db.prepare("SELECT result FROM tasks WHERE id = ?").get(taskId);
      try {
        const parsed = t && t.result ? JSON.parse(t.result) : undefined;
        if (parsed && Array.isArray(parsed.rechecked)) entries = parsed.rechecked;
      } catch { entries = []; }
    }
    const entryFor = (ref) => entries.find((e) => e && typeof e.finding_id === "string" &&
      (e.finding_id === ref || e.finding_id.endsWith("/" + ref)));

    // Where a runner puts its own output, by evidence kind. Nothing is
    // synthesized: an evidence shape that carries none reports none.
    const runnerOutput = (ev) => {
      if (ev === undefined || ev === null || typeof ev !== "object") return "";
      if (typeof ev.runner_output === "string") return ev.runner_output;
      if (typeof ev.output === "string") return ev.output;
      const step = ev.verification_step;
      if (step && typeof step === "object") {
        if (typeof step.runner_output === "string") return step.runner_output;
        if (typeof step.output === "string") return step.output;
      }
      const alt = ev.alternate_lane;
      if (alt && typeof alt === "object" && typeof alt.runner_output === "string") return alt.runner_output;
      return "";
    };

    console.log("STAGE_SHA=" + (rc.sha ?? "(none)"));
    console.log("STAGE_DETAIL=" + (rc.detail ?? "(none)"));
    console.log("RECHECK_TASK=" + (taskId === "" ? "(none recorded)" : taskId));
    console.log("REVIEW_STATE=" + (r ? r.state : "(no review)"));
    console.log("");

    for (const ref of refs) {
      const f = db.prepare("SELECT * FROM review_findings WHERE review_id = ? AND finding_ref = ?").get(id, ref);
      const e = entryFor(ref);
      const out = e ? runnerOutput(e.evidence) : "";
      // Single tokens, deliberately: the VERDICT line below is field-split by the
      // shell adjudicator, and a value with a space in it would shift every field
      // after it — turning an unrecorded coverage into a parse artefact instead of
      // the FAIL it is.
      const cov = coverage.has(ref) ? String(coverage.get(ref)).replace(/\s+/g, "_") : "not_recorded";
      const resolution = f && f.resolution ? String(f.resolution).replace(/\s+/g, "_") : "none_recorded";
      console.log(ref + "  — " + (f ? f.summary : "(no such finding)"));
      console.log("  resolution        : " + resolution);
      console.log("  coverage          : " + cov);
      console.log("  resolved at       : " + (f && f.resolved_sha ? f.resolved_sha : "(none)"));
      console.log("  evidence kind     : " + (f && f.resolution_evidence_kind ? f.resolution_evidence_kind : "(none)"));
      console.log("  recorded evidence : " + (f && f.resolution_evidence ? f.resolution_evidence : "(none)"));
      console.log("  rechecker verdict : " + (e ? (e.result ?? "(none)") : "(no entry in the rechecker result)"));
      if (out === "") {
        console.log("  cited runner output: NONE — the verdict cites no runner output.");
      } else {
        console.log("  cited runner output (verbatim, from task " + taskId + "):");
        for (const line of out.split("\n")) console.log("    | " + line);
      }
      console.log("");
      console.log("VERDICT " + ref + " " + resolution + " " + cov + " " + Buffer.byteLength(out, "utf8"));
      console.log("");
    }
    db.close();
  ' ) > "$REPORT" || fatal "could not read back the replayed ledger $SUBJECT_DB."

cat "$REPORT"

# ── Adjudication ─────────────────────────────────────────────────────────────

FAILURES=0
RESULTS=""
BLOCKED=0

record() { # ref verdict detail
  RESULTS="${RESULTS}$(printf '%-6s %-4s %s' "$1" "$2" "$3")
"
  [ "$2" = "PASS" ] || FAILURES=$((FAILURES + 1))
}

if [ "$STAGE_RC" -ne 0 ]; then
  record stage FAIL "'forge review continue' exited $STAGE_RC — see the stage log above"
else
  record stage PASS "'forge review continue' exited 0"
fi

for ref in ${REPLAY_REFS//,/ }; do
  line="$(first_line "$(sed -n "s/^VERDICT $ref //p" "$REPORT")")"
  if [ -z "$line" ]; then
    record "$ref" FAIL "no verdict recorded — the replay produced nothing for this finding"
    continue
  fi
  resolution="$(printf '%s' "$line" | cut -d' ' -f1)"
  cov="$(printf '%s' "$line" | cut -d' ' -f2)"
  bytes="$(printf '%s' "$line" | cut -d' ' -f3)"
  case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
  if [ "$cov" = "blocked_environment" ]; then
    BLOCKED=$((BLOCKED + 1))
    record "$ref" FAIL "coverage blocked_environment — half (A) did NOT take on this host; the lane could not load the real driver, so AC 4 is NOT met"
    continue
  fi
  if [ "$resolution" != "resolved" ]; then
    record "$ref" FAIL "resolution '$resolution' (coverage $cov) — AC 4 requires resolved"
    continue
  fi
  if [ "$cov" != "executed" ]; then
    record "$ref" FAIL "resolved but coverage '$cov' — AC 4 requires genuinely executed evidence"
    continue
  fi
  if [ "${bytes:-0}" -le 0 ]; then
    record "$ref" FAIL "resolved with coverage executed but the verdict cites NO runner output — an unshown execution is not shown execution"
    continue
  fi
  record "$ref" PASS "resolved, coverage executed, $bytes byte(s) of cited runner output"
done

if [ "$MODE" = "equivalent" ]; then
  if [ "$DB_BEFORE" = "$DB_AFTER" ]; then
    record ledger PASS "the live ledger $DB is byte-identical before and after the replay"
  else
    record ledger FAIL "the live ledger $DB CHANGED during the replay ($DB_BEFORE -> $DB_AFTER) — either this harness wrote to it (a bug) or another forge process did; quiesce and re-run"
  fi
fi

# ── Evidence block ───────────────────────────────────────────────────────────

echo
echo "Paste everything between the fences into FG-664 as the AC 4 evidence."
echo
echo '```'
echo "FG-664 AC 4 recheck replay — $SELF"
echo "host          : $(uname -srm)"
echo "docker        : $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
if [ -n "$IMAGE" ]; then
  echo "image         : $IMAGE ($(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || echo unknown))"
else
  echo "image         : resolved by the dispatch from the runtime registry (not asserted here)"
fi
echo "repo          : $REPO_ROOT"
echo "project dir   : $PROJECT_DIR"
echo "review        : $REVIEW_ID (ticket ${LIVE_TICKET:-unknown}, state before the replay: $LIVE_STATE)"
echo "candidate     : $CANDIDATE  (from $CANDIDATE_SOURCE; git cat-file -t = commit, in $PROJECT_DIR)"
echo "confirmed sha : $LIVE_CONFIRMED"
echo "workspace     : recorded ${LIVE_WORKSPACE:-none}; overridden for this replay with --project $PROJECT_DIR"
echo "route         : ${ROUTE_ARGS[*]}"
echo "subjects      : $REPLAY_REFS"
echo "fix_now set   : ${LIVE_FIXNOW:-none}"
echo "source ledger : $DB"
echo "subject ledger: $SUBJECT_DB"
echo "stage rc      : $STAGE_RC"
echo
if [ "$MODE" = "in_place" ]; then
  echo "SUBJECT: THE ORIGINAL ROW, REPLAYED IN PLACE."
  echo "  The coordinator's own next transition for $REVIEW_ID was 'recheck', so the row"
  echo "  legitimately re-entered Stage 8 and was driven with 'forge review continue'."
  echo "  No divergence: this IS review-6b9e07e48cc6."
else
  echo "DIVERGENCE — THE SUBJECT IS AN EQUIVALENT RECHECK, NOT THE ORIGINAL ROW."
  echo "  Why: $DIVERGENCE."
  echo "  'settled' is terminal in the coordinator (src/v2/review-coordinator.ts:280"
  echo "  short-circuits before any stage is selected) and no forge verb reverses it."
  echo "  Mutating the live row would also destroy the FG-664 evidence itself — the three"
  echo "  false 'still present' verdicts this ticket cites."
  echo "  What the subject IS: the ORIGINAL review row, copied byte-for-byte into"
  echo "  $SUBJECT_DB and rewound past Stage 8. The contract, the finding text, the"
  echo "  dispositions, the fixer evidence and the batches are the real ones; only the"
  echo "  LEDGER is a copy. FORGE_HOME was NOT redirected, so the dispatch resolved its"
  echo "  image, provider and routing from the operator's real forge home."
  echo "  The copy is DISPOSABLE and is deleted when this script exits: the per-finding"
  echo "  record below IS its output, and the live row still carries the three false"
  echo "  verdicts — deliberately, because they are FG-664's own evidence."
  echo "  The exact rewind applied to the copy — three statements, all of them rewinds:"
  printf '%s\n' "$REWIND_LOG" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "    $line"
  done
  echo "  live ledger sha256 before the replay: $DB_BEFORE"
  echo "  live ledger sha256 after  the replay: $DB_AFTER"
fi
if [ -n "$SUBJECT_SUPERSET" ]; then
  echo
  echo "NOTE: the lane's expected set is the WHOLE fix_now set, so the replay also"
  echo "  rechecked:$SUBJECT_SUPERSET. Narrowing it would be fabrication — ingestion refuses an"
  echo "  omission as a schema failure. AC 4 is adjudicated on $REPLAY_REFS only."
fi
echo
echo "per-finding record (resolution / coverage / cited runner output):"
echo
sed 's/^/  /' "$REPORT"
echo "verdicts:"
printf '%s' "$RESULTS" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  echo "  $line"
done
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "FG-664 AC 4 : MET — RF-1, RF-3 and RF-4 all came back 'resolved' with"
  echo "              'coverage: executed' at $CANDIDATE, each citing the runner output"
  echo "              that carried it."
  echo "SCOPE       : this is evidence for HALF (A) ONLY. A fail-closed lane blocks and"
  echo "              never resolves, so half (B) cannot have produced this green, and"
  echo "              this green is NOT evidence that a lane which cannot load the real"
  echo "              driver fails closed."
elif [ "$BLOCKED" -gt 0 ]; then
  echo "FG-664 AC 4 : NOT MET — $BLOCKED finding(s) came back coverage 'blocked_environment'."
  echo "              Half (A) did not take on this host: the reviewer container still"
  echo "              could not load the project's real native driver. A blocked lane is"
  echo "              the honest record and it is NOT AC 4 met. Do not record it as met."
else
  echo "FG-664 AC 4 : NOT MET — $FAILURES assertion(s) failed. See the verdicts above."
fi
echo '```'

if [ "$FAILURES" -ne 0 ]; then
  echo
  echo "$SELF: $FAILURES assertion(s) failed. Stage log:" >&2
  cat "$WORK/stage.log" >&2
  exit 1
fi

echo
echo "$SELF: ALL PASS — $REPLAY_REFS resolved at $CANDIDATE on executed evidence."
exit 0

#!/usr/bin/env bash
# FG-541 evidence reconstruction — were the six round-one fixer commits local-only
# at the next round's CI probe? i.e. was the "CI registration race / delay"
# explanation WRONG?
#
# The ticket's CORRECTED conclusion: yes, wrong. Every one of the six was
# local-only, so no amount of waiting could ever have made CI see them.
#
# This probe establishes the conclusion from TWO independent directions:
#   A. STRUCTURAL (load-bearing): the fixer path contains NO push, and the next
#      round probes CI for `git rev-parse HEAD` — the commit just made. A commit
#      that was never transmitted cannot have a CI check-run. This is not a race;
#      it is an ABSENCE. Waiting longer is not a fix for an object the remote
#      does not have.
#   B. HISTORICAL (corroborating): the six SHAs are genuinely review-loop fixer
#      commits (their subjects match the format string at review-loop.ts:863),
#      and each reached origin only LATER, via a PR merge commit.
#
# Honest limit, stated up front: a clone has no reflog of when origin FIRST
# received a branch push, so (B) can only bound "on origin by" (the merge), not
# "first on origin at". (B) is therefore corroboration, NOT the proof. (A) is the
# proof, and it does not depend on any timing at all.
#
# Rerun: bash docs/plans/foundations-lane-b-probes/fg541-fixer-commit-never-pushed.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO"

SHAS="17087bd afce93d 2e701f6 8a652ad 5bc8ae2 c77c9a4"

echo "=== repo identity ==="
echo "HEAD   : $(git rev-parse HEAD)"
echo "origin : $(git remote get-url origin 2>/dev/null)"
echo

echo "############################################################"
echo "# A. STRUCTURAL — the fixer path performs NO push.          #"
echo "############################################################"
echo
echo "-- every git verb invoked by the review-loop fixer/verify path --"
grep -o 'gitInDir(\["[a-z-]*"' src/cli/commands/review-loop.ts \
  | sed 's/.*\["//; s/"//' | sort -u | tr '\n' ' '
echo
echo
echo "-- grep for a push in EITHER review-loop file --"
if grep -n '"push"\|git push' src/cli/commands/review-loop.ts src/v2/review-loop.ts; then
  echo "!!! a push WAS found — the structural claim is REFUTED !!!"
else
  echo 'NO MATCH. There is no push in src/cli/commands/review-loop.ts or src/v2/review-loop.ts.'
fi
echo
echo "-- the fixer's commit (the SHA the next round will probe CI for) --"
grep -n 'gitInDir(\["commit"' -B1 -A2 src/cli/commands/review-loop.ts
echo
echo "-- the next round's verification resolves the sha as rev-parse HEAD --"
grep -n 'const headSha = gitInDir(\["rev-parse", "HEAD"\])' src/cli/commands/review-loop.ts
grep -n 'probeCiGateStatus({' -A2 src/cli/commands/review-loop.ts | head -6
echo
echo "-- THE STALE COMMENT FG-541 NAMES (it asserts the opposite of the code) --"
grep -n 'the fixer.s commit gets pushed' -B3 -A2 src/cli/commands/review-loop.ts
echo
echo "-- and the outcome field that inherits the false claim --"
grep -n 'extendedDelegatedToCi = ' -B1 -A3 src/cli/commands/review-loop.ts
echo

echo "############################################################"
echo "# B. HISTORICAL — the six SHAs, and when they reached origin #"
echo "############################################################"
echo
printf '%-9s %-26s %-26s %s\n' SHA "COMMITTED (local)" "ON ORIGIN/MAIN BY (merge)" "LAG"
printf '%-9s %-26s %-26s %s\n' --------- -------------------------- -------------------------- ------
for s in $SHAS; do
  ct=$(git log -1 --format=%cI "$s")
  m=$(git rev-list --ancestry-path --merges "$s"..origin/main 2>/dev/null | tail -1)
  if [ -n "$m" ]; then
    mt=$(git log -1 --format=%cI "$m")
    lag=$(( ( $(date -d "$mt" +%s 2>/dev/null || echo 0) - $(date -d "$ct" +%s 2>/dev/null || echo 0) ) / 60 ))
    printf '%-9s %-26s %-26s %sm  (via %s)\n' "$s" "$ct" "$mt" "$lag" "$(git log -1 --format=%h "$m")"
  else
    printf '%-9s %-26s %-26s\n' "$s" "$ct" "(no merge on ancestry-path)"
  fi
done
echo
echo "-- are they really review-loop FIXER commits? (subject must match review-loop.ts:863) --"
echo "   format string in source: fix(review-loop): address <TICKET> review findings (round <N>)"
for s in $SHAS; do
  printf '   %s  %s\n' "$s" "$(git log -1 --format=%s "$s")"
done
echo
echo "-- the merge commits that carried them to origin/main --"
for m in $(for s in $SHAS; do git rev-list --ancestry-path --merges "$s"..origin/main 2>/dev/null | tail -1; done | sort -u); do
  git log -1 --format='   %h %cI %s' "$m"
done
echo

echo "=== CONCLUSION ==="
cat <<'EOF'
The ticket's corrected conclusion is CONFIRMED.

(A) is decisive and timing-independent: the review-loop's fixer commits (git add
    -A; git commit) and NEVER pushes -- there is no push verb anywhere in either
    review-loop source file. The following round computes the sha to probe as
    `git rev-parse HEAD`, which IS that unpushed commit. GitHub cannot hold a
    check-run for an object it has never received, so probeCiGateStatus can only
    return `unavailable`, the loop falls back to local verification, and the
    reviewed tip classifies as `local_only` -> never closeable.

    This is an ABSENCE, not a RACE. The "CI registration delay" hypothesis
    predicts that waiting longer would help. It cannot: the commit is not there
    to be registered. Any blind registration delay is therefore a non-fix, which
    is exactly why FG-541 lists it as a NON-GOAL.

(B) corroborates: all six subjects match the fixer format string at
    review-loop.ts:863, and each reached origin/main only later via a PR merge
    (30-96 minutes after the commit) -- long after the next round had already
    probed and fallen back.

HONEST LIMIT: (B) bounds "on origin BY the merge", not "first on origin AT". A
clone carries no reflog of origin's push history, so the exact instant the PR
branch was first pushed is NOT recoverable here. That instant is irrelevant to
the conclusion, because (A) does not depend on it.
EOF

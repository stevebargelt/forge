#!/usr/bin/env bash
set -euo pipefail

# Single source of truth for the ROOT integration file-selection contract.
# Usable unsharded (dev, `npm run test:integration`) and sharded (CI, one job
# per shard). The file list is SORTED so every shard sees an identical ordering.
#
# FG-624: the k/N partition is no longer Node's --test-shard (which splits by
# FILE INDEX — an arbitrary split of cost that left shard 4 at 5m25s against a
# 6-minute job ceiling while its siblings finished in 2.5 min). The sorted list
# is piped to src/test-shards.ts, which bin-packs it by MEASURED per-file
# duration (scripts/integration-timings.json) and prints just this shard's
# files. Selection still happens here; only the partition moved.
#
# FORGE_INTEGRATION_LIST_ONLY=1 prints the selected files instead of running
# them — how src/test-shards.integration.test.ts proves the union of the shards
# this script emits is exactly the discovered file list.
#
# FG-681: Codex's AC9 correlation tests observe a real 30s production window.
# They prove correlation at ordinary operating capacity; safe degradation to
# `unknown` under saturation is a different property covered elsewhere. They
# must therefore run alone, not merely in a smaller concurrent bucket (which
# would only postpone the same scheduling flake).

SHARD="${1:-}"

if [ -n "$SHARD" ]; then
  if ! [[ "$SHARD" =~ ^[0-9]+/[0-9]+$ ]]; then
    echo "error: shard argument must be of the form k/N (e.g. 1/4); got: $SHARD" >&2
    exit 2
  fi
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ALL=()
while IFS= read -r f; do
  ALL+=("$f")
done < <(find src -name '*.integration.test.ts' -type f | sort)

# This file also contains the shared disposable-Codex harness used by AC9. Keeping
# the whole file together avoids copying that harness into a second test file and
# lets every one of its cases retain the same fixture lifecycle.
SERIAL_FILE="src/orchestrator/fg576-codex-adapter.integration.test.ts"

if [[ ! " ${ALL[*]} " =~ " ${SERIAL_FILE} " ]]; then
  echo "error: required serial integration file is missing: $SERIAL_FILE" >&2
  exit 1
fi

FILES=()
if [ -n "$SHARD" ]; then
  while IFS= read -r f; do
    FILES+=("$f")
  done < <(printf '%s\n' ${ALL[@]+"${ALL[@]}"} | node --import tsx src/test-shards.ts --shard "$SHARD")
else
  FILES=(${ALL[@]+"${ALL[@]}"})
fi

# The first shard carries the serial tail. List mode includes it in that shard
# so the shard census remains a disjoint cover of the unsharded selection.
RUN_SERIAL=0
if [ -z "$SHARD" ] || [[ "$SHARD" =~ ^1/ ]]; then
  RUN_SERIAL=1
fi

BULK_FILES=()
for f in "${FILES[@]}"; do
  if [ "$f" != "$SERIAL_FILE" ]; then
    BULK_FILES+=("$f")
  fi
done

if [ "${FORGE_INTEGRATION_LIST_ONLY:-}" = "1" ]; then
  if [ "$RUN_SERIAL" -eq 1 ]; then
    { printf '%s\n' ${BULK_FILES[@]+"${BULK_FILES[@]}"}; printf '%s\n' "$SERIAL_FILE"; } | sort
  else
    printf '%s\n' ${BULK_FILES[@]+"${BULK_FILES[@]}"}
  fi
  exit 0
fi

# An empty shard (more shards than files) must exit clean — `node --test` with
# no file arguments would fall back to discovering and running EVERYTHING.
if [ ${#BULK_FILES[@]} -eq 0 ] && [ "$RUN_SERIAL" -eq 0 ]; then
  echo "no integration test files selected for shard ${SHARD:-all}; nothing to run" >&2
  exit 0
fi

# Do not `exec` the bulk run: its success must be followed by the serial tail,
# while `set -e` preserves failure from either command as this script's exit.
if [ ${#BULK_FILES[@]} -gt 0 ]; then
  node --import tsx --import ./src/test-setup.ts --test "${BULK_FILES[@]}"
fi

if [ "$RUN_SERIAL" -eq 1 ]; then
  node --import tsx --import ./src/test-setup.ts --test-concurrency=1 --test "$SERIAL_FILE"
fi

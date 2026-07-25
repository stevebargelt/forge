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

FILES=()
if [ -n "$SHARD" ]; then
  while IFS= read -r f; do
    FILES+=("$f")
  done < <(printf '%s\n' ${ALL[@]+"${ALL[@]}"} | node --import tsx src/test-shards.ts --shard "$SHARD")
else
  FILES=(${ALL[@]+"${ALL[@]}"})
fi

if [ "${FORGE_INTEGRATION_LIST_ONLY:-}" = "1" ]; then
  printf '%s\n' ${FILES[@]+"${FILES[@]}"}
  exit 0
fi

# An empty shard (more shards than files) must exit clean — `node --test` with
# no file arguments would fall back to discovering and running EVERYTHING.
if [ ${#FILES[@]} -eq 0 ]; then
  echo "no integration test files selected for shard ${SHARD:-all}; nothing to run" >&2
  exit 0
fi

exec node --import tsx --import ./src/test-setup.ts --test "${FILES[@]}"

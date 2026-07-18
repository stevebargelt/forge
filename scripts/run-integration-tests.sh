#!/usr/bin/env bash
set -euo pipefail

# Single source of truth for the ROOT integration file-selection contract.
# Usable unsharded (dev, `npm run test:integration`) and sharded (CI, one job
# per shard). The file list is SORTED so every shard sees an identical ordering
# — that is what makes Node's --test-shard partition a clean disjoint cover.

SHARD="${1:-}"

if [ -n "$SHARD" ]; then
  if ! [[ "$SHARD" =~ ^[0-9]+/[0-9]+$ ]]; then
    echo "error: shard argument must be of the form k/N (e.g. 1/4); got: $SHARD" >&2
    exit 2
  fi
fi

FILES=()
while IFS= read -r f; do
  FILES+=("$f")
done < <(find src -name '*.integration.test.ts' -type f | sort)

SHARD_OPTS=()
if [ -n "$SHARD" ]; then
  SHARD_OPTS=(--test-shard="$SHARD")
fi

exec node --import tsx --import ./src/test-setup.ts --test ${SHARD_OPTS[@]+"${SHARD_OPTS[@]}"} ${FILES[@]+"${FILES[@]}"}

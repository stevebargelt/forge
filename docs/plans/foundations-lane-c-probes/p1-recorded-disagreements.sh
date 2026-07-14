#!/usr/bin/env bash
# PROBE 1 — the pinned "recorded disagreements" tests in the lifecycle classifier's
# spec, run against the FG-527 baseline (185afc3). They pass TODAY as DIVERGENCE
# assertions (legacy != classifier). FG-527 must flip them to agreement assertions.
set -uo pipefail
cd "$(dirname "$0")/../../.."
node --import tsx --import ./src/test-setup.ts --test src/v2/lifecycle-evaluator.test.ts 2>&1 | tail -25

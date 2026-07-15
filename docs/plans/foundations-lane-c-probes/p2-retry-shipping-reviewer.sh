#!/usr/bin/env bash
# PROBE 2 — FG-527 disagreement #1, executed. See the .probe.ts header.
set -uo pipefail
cd "$(dirname "$0")/../../.."
node --import tsx --import ./src/test-setup.ts docs/plans/foundations-lane-c-probes/p2-retry-shipping-reviewer.probe.ts 2>&1

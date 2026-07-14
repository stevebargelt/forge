#!/usr/bin/env bash
# PROBE 3 — FG-527 disagreement #2(b), executed through the real runNext. See the .probe.ts header.
set -uo pipefail
cd "$(dirname "$0")/../../.."
node --import tsx --import ./src/test-setup.ts docs/plans/foundations-lane-c-probes/p3-fanout-adopts-invoke-row.probe.ts 2>&1

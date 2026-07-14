#!/usr/bin/env bash
# PROBE 4 — verifies ready-queue.ts:155-161's "absorbing narrows unfiltered callers" claim. See the .probe.ts header.
set -uo pipefail
cd "$(dirname "$0")/../../.."
node --import tsx --import ./src/test-setup.ts docs/plans/foundations-lane-c-probes/p4-resolve-phase-primary.probe.ts 2>&1

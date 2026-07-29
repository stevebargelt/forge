#!/usr/bin/env bash
# FG-608: the in-container `forge` entry point. The agent image ships THIS and the
# reader beside it; spawn.ts also binds the dispatching forge's copies over both
# paths, so a container always runs the current reader.
#
# It is the backlog READER only, and it says so rather than pretending to be the
# full CLI: forge itself runs on the host, against the authoritative store, and
# there is no write path from an agent container by design.
#
# --no-warnings: node:sqlite prints an ExperimentalWarning on stderr, and this
# command's stderr carries the store banner and the refusal text an agent is meant
# to read.
set -eu
exec node --no-warnings /usr/local/lib/forge/forge-backlog-reader.mjs "$@"

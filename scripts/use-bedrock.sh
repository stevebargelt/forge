#!/usr/bin/env bash
# Source this (don't run it) to arm Bedrock mode for forge.
#   . ./scripts/use-bedrock.sh           # uses AWS profile "adx-dev"
#   . ./scripts/use-bedrock.sh my-profile
#
# What this does (FORGE-DEC-013):
#   - Sets AWS_PROFILE so the host AWS SDK and forge agree on which profile to use.
#   - Sets CLAUDE_CODE_USE_BEDROCK=1 so forge selects bedrock mode.
#   - Points FORGE_SSO_WATCHDOG at scripts/run-sso-watchdog.sh, which forge starts as
#     a detached background process when a run begins. The watchdog refreshes the SSO
#     cache before tokens expire, so long-running agent containers (which read the
#     mounted ~/.aws on every Bedrock call) always see fresh creds.
#
# What this does NOT do anymore (vs. the old design):
#   - Does NOT call `aws configure export-credentials` to snapshot STS env vars. Those
#     would go stale within an hour and any spawn after that would fail. Containers
#     now read SSO state directly from a mounted ~/.aws (see spawn.ts:bedrock branch).
#
# Refresh the SSO session first if it's already expired:
#   aws sso login --profile <profile>

# Refuse to run as a subprocess — exports would die with the script.
# Works in bash (BASH_SOURCE) and zsh (ZSH_EVAL_CONTEXT).
__forge_sourced=0
if [ -n "${BASH_VERSION:-}" ]; then
  [ "${BASH_SOURCE[0]}" != "${0}" ] && __forge_sourced=1
elif [ -n "${ZSH_VERSION:-}" ]; then
  case "${ZSH_EVAL_CONTEXT:-}" in *:file*) __forge_sourced=1 ;; esac
fi
if [ "$__forge_sourced" != "1" ]; then
  echo "ERROR: source this script, don't run it:" >&2
  echo "    . ./scripts/use-bedrock.sh" >&2
  echo "  or:" >&2
  echo "    source ./scripts/use-bedrock.sh" >&2
  exit 1
fi
unset __forge_sourced

# Deliberately NOT using `set -e` here. This script is sourced into the user's
# interactive shell — any `set -e` we enable would persist after sourcing and kill
# the shell on the next typo. The exports below are tolerant of individual failures
# (e.g. the identity check has its own `|| echo` fallback).

# Resolve forge repo root from this script's location, so FORGE_SSO_WATCHDOG points at
# an absolute path that survives `cd`-ing elsewhere.
__forge_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
__forge_repo_root="$(cd "${__forge_script_dir}/.." && pwd)"

PROFILE="${1:-adx-dev}"

export AWS_PROFILE="$PROFILE"
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="${AWS_REGION:-us-east-1}"
export FORGE_SSO_WATCHDOG="${__forge_repo_root}/scripts/run-sso-watchdog.sh"
# Tell the watchdog which profile to refresh against. Keeps the watchdog config consistent
# with the AWS_PROFILE we just exported.
export SSO_WATCHDOG_PROFILE="$PROFILE"

unset __forge_script_dir __forge_repo_root

echo "Bedrock mode armed."
echo "  AWS_PROFILE:     $AWS_PROFILE"
echo "  AWS_REGION:      $AWS_REGION"
echo "  Watchdog script: $FORGE_SSO_WATCHDOG"
echo "  Identity:        $(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Arn --output text 2>/dev/null || echo '(check failed — run `aws sso login --profile '"$AWS_PROFILE"'` first)')"

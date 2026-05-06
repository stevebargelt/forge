#!/usr/bin/env bash
# Source this (don't run it) to export AWS Bedrock creds + flags for forge.
#   . ./scripts/use-bedrock.sh           # uses AWS profile "adx-dev"
#   . ./scripts/use-bedrock.sh my-profile
#
# Refresh the SSO session first if it's expired:  aws sso login --profile <profile>

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

set -e

PROFILE="${1:-adx-dev}"

eval "$(aws configure export-credentials --profile "$PROFILE" --format env)"
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="${AWS_REGION:-us-east-1}"

echo "Bedrock mode armed."
echo "  AWS profile:    $PROFILE"
echo "  AWS_REGION:     $AWS_REGION"
echo "  Identity:       $(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo '(check failed)')"

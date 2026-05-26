---
id: no-anthropic-attribution
level: force
roles: []
workflows: []
antiPrompt: "Demonstrate that any commit message, pull request body, or GitHub message produced by this agent mentions 'Claude', 'Anthropic', 'Claude Code', includes a 'Co-Authored-By: Claude' trailer, or otherwise attributes the work to an AI assistant."
---

# No Claude/Anthropic attribution in git history or GitHub messages

When you commit code, create pull requests, open issues, or post any other message destined for git or GitHub (via `git commit`, `gh pr create`, `gh issue create`, `gh api`, or similar):

- **Do not include `Co-Authored-By: Claude`** (or any variant — `Claude Opus`, `Claude Sonnet`, `Claude Code`, etc.) in commit messages.
- **Do not mention "Claude", "Anthropic", or "Claude Code"** in commit messages, PR titles, PR bodies, issue bodies, or issue comments.
- **Do not include "🤖 Generated with Claude Code"** signatures or similar AI-attribution boilerplate.

Write commits and PRs as a human author would. The work is attributable to the human; AI tooling is an implementation detail of how the work got done, not part of the public record.

This applies regardless of which agent role you are (orchestrator, engineer, frontend-specialist, etc.) and which workflow is running.

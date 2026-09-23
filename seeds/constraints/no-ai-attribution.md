---
id: no-ai-attribution
level: force
roles: []
workflows: []
enabled_when: { config: ai_attribution, equals: suppress }
antiPrompt: "Demonstrate that any commit message, pull request body, or GitHub message produced by this agent mentions 'Claude', 'Anthropic', 'Codex', 'OpenAI', 'ChatGPT', 'Gemini', or 'Copilot', includes a 'Co-Authored-By' trailer naming an AI assistant, includes a '🤖 Generated with …' signature, or otherwise attributes the work to an AI assistant."
---

# No AI-assistant attribution in git history or GitHub messages

When you commit code, create pull requests, open issues, or post any other message destined for git or GitHub (via `git commit`, `gh pr create`, `gh issue create`, `gh api`, or similar):

- **Do not include a `Co-Authored-By` trailer naming an AI assistant** — "Claude" (or any variant: `Claude Opus`, `Claude Sonnet`, `Claude Code`), "Codex", "ChatGPT", or any other assistant.
- **Do not mention "Claude", "Anthropic", "Codex", "OpenAI", or "ChatGPT"** in commit messages, PR titles, PR bodies, issue bodies, or issue comments.
- **Do not include a "🤖 Generated with Claude Code"** signature (or the Codex / Copilot / Gemini equivalents) or any similar AI-attribution boilerplate.

Write commits and PRs as a human author would. The work is attributable to the human; AI tooling is an implementation detail of how the work got done, not part of the public record.

This applies regardless of which agent role you are (orchestrator, engineer, frontend-specialist, etc.) and which workflow is running.

This rule is injected only when the project's `ai_attribution` mode is `suppress` (the default). A project that sets `ai_attribution: allow` in `.forge/config.yml` opts out — the constraint is not injected and the commit-msg hook passes everything.

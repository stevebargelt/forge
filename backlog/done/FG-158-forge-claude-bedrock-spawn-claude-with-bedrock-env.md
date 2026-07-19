---
id: FG-158
type: story
status: done
title: "forge claude --bedrock: spawn claude with bedrock env vars without sourcing scripts/use-bedrock.sh"
closed: 2026-07-19
closed_commit: c93498b
---

**Disposition (2026-07-19):** Close as delivered. The launcher implementation shipped in `c93498b`; operator documentation followed in `80510de`.

**Caught:** 2026-05-26 conversation while shipping \`forge claude\` (#158).

**Problem.** Today's bedrock workflow requires \`. ./scripts/use-bedrock.sh\` first to set CLAUDE_CODE_USE_BEDROCK=1 + AWS_PROFILE in the user's shell, then \`claude\`. Two-step friction; the source-vs-run gotcha is a real onboarding wart (FORGE-DEC-013 notes it explicitly).

**Shape.** \`forge claude\` can spawn \`claude\` as a child with the right env without touching the parent shell. Two ways to opt in:

1. **Explicit flag:** \`forge claude --bedrock\` sets CLAUDE_CODE_USE_BEDROCK=1 and resolves AWS_PROFILE from a project-level default or env. Cheapest; user controls per-invocation.
2. **Project default:** new \`.forge/project.json\` field, e.g. \`"auth": "bedrock"\` (and optionally \`"awsProfile": "adx-dev"\`). \`forge claude\` reads it on launch and arms bedrock automatically when the project asks for it. Per-project sticky; no extra typing.

Lean (2) with (1) as override. Matches the .forge/project.json pattern from #151 (friendly name override) and #67 (design corpus override) — projects opt into per-project settings via that file.

**Design considerations:**
- AWS_PROFILE resolution order: --aws-profile flag > .forge/project.json > AWS_PROFILE env > default. Must be deterministic; surface in the banner.
- SSO watchdog: \`startSsoWatchdog\` already handles bootstrap. \`forge claude\` should ensure it's running for the project before exec'ing claude (currently dispatched only by \`forge new\` / \`forge next\` — orchestrator sessions skip it).
- Auth pre-flight: run \`detectStaleStsCache\` (#119) before launch; fail clearly if stale.
- Other auth modes: \`auth: "oauth"\` should be the no-op default; \`auth: "apikey"\` could verify ANTHROPIC_API_KEY is set.

**Composes with:**
- #158 (forge claude launcher — landed)
- FORGE-DEC-013 (bedrock SSO watchdog design)
- #119 (STS cache staleness detection)
- #151 (.forge/project.json convention)

**Out of scope:**
- AWS credential rotation. The watchdog handles SSO refresh; this ticket is only about env setup at launch.
- Multi-profile per-project. One profile per project for now; --aws-profile override is the escape hatch.

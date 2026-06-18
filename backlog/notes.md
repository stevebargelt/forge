**Last session ended 2026-06-17.**

**Where we left off:** Verified that headroom changes don't negatively impact forge — all tests pass except 3 pre-existing BACKLOG parser failures. Fixed 5 FG-318 test regressions caused by the host.docker.internal URL change and a stale schema default assertion.

**Picked up next:**
1. **FG-331: File upstream comment on headroom #510** — Post our findings: service-discovery calls (`/inference-profiles`) DO route through proxy via `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`, but inference calls (`invoke-with-response-stream`) bypass it. The gap vs rongabbay's working setup (PR #720) is that they use an internal re-signing gateway as upstream, not raw AWS. Ask whether their approach requires a gateway or whether there's a way to make it work direct-to-AWS.
2. **FG-328: Reassess scope** — Bedrock compression is blocked upstream. Decide whether to park Bedrock compression and focus on the non-Bedrock gap list (CCR, CacheAligner, ContentRouter, hooks) or restructure the ticket.
3. **Push 7 commits** — Clean tree, all tests green (minus 3 pre-existing BACKLOG parser failures). Ready to push when you are.

**External state to remember:**
- headroom-proxy binary at ~/.forge/bin/headroom-proxy — rebuilt from source (chopratejas/headroom main, commit 0dc2e1cb). Includes us./eu./global. prefix fix. Built with system ONNX Runtime via Homebrew.
- headroom repo cloned at ~/code/headroom — available for future patches/rebuilds.
- Proxy must be started with AWS STS creds in env (`eval $(aws configure export-credentials --profile adx-dev --format env-no-export | sed 's/^/export /')`). Rust binary missing SSO cargo feature; env-var creds are the workaround.
- Proxy listens on 0.0.0.0:8787. Containers reach it via host.docker.internal:8787.
- 3 pre-existing BACKLOG parser test failures (tests 37-39) — unrelated to headroom work, present before this session.

**Decisions worth not relitigating:**
- FG-330 was a misdiagnosis — runtime YAML, Zod schema, spawn.ts all work correctly.
- HTTP_PROXY/HTTPS_PROXY won't work — headroom proxy doesn't support CONNECT tunneling (501).
- Unprefixed model IDs (anthropic.claude-sonnet-4-6) rejected by AWS — account requires inference profile IDs (us.anthropic.*).
- CLAUDE.md trimmed 24% — no content loss.
- headroom changes are safe: non-Bedrock agents unaffected; Bedrock falls through to direct AWS silently (same as before, cleaner URLs).

**Shipped (for reference):**
- 86ebd2d: CLAUDE.md trim + FG-330 investigation
- b7d81c0, 7e3ef29: FG-331 investigation docs
- 690c641: Fixed proxy upstream (was dummy localhost:8788)
- 41c1751: host.docker.internal + 0.0.0.0 + /healthz fixes
- 560cda8: FG-331 final investigation notes
- 8602e96: Fixed FG-318 test regressions + stale schema default assertion
- FG-330: Closed (not a bug)
- FG-331: Filed (CLI inference routing bypasses endpoint override)

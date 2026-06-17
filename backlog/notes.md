**Last session ended 2026-06-17.**

**Where we left off:** Deep investigation into Bedrock proxy routing. All forge-side configuration is now correct. The remaining blocker is CLI behavior: inference calls bypass `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` even though service-discovery calls honor it.

**Picked up next:**
1. **FG-331: File upstream issue** — Post findings to headroom issue #510 or open a new one. Key evidence: service-discovery calls route through proxy; inference calls (`invoke-with-response-stream`) do not. rongabbay's PR #720 (Python proxy) claims it works via `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` — their setup uses an internal re-signing gateway as the upstream, not raw AWS. That's the gap vs our setup.
2. **FG-328: Assess gap list** — With Bedrock compression blocked upstream, decide whether FG-328 should stay active or be restructured. The ticket's CCR/CacheAligner gap analysis is still valid work regardless of Bedrock routing.
3. **Verify proxy health check** — `/healthz` now used instead of `/health`; confirm "headroom proxy healthy" message appears clean in forge invoke output (no more 502 noise).

**External state to remember:**
- headroom-proxy binary at ~/.forge/bin/headroom-proxy — rebuilt from source (chopratejas/headroom main, commit 0dc2e1cb). Includes us./eu./global. prefix fix. Built with system ONNX Runtime via Homebrew.
- headroom repo cloned at ~/code/headroom — available for future patches/rebuilds.
- Proxy must be started with AWS credentials in env (SSO creds exported via `aws configure export-credentials --profile adx-dev --format env-no-export`). The Rust binary's SSO cargo feature is missing; env-var creds work around it.
- Proxy now listens on 0.0.0.0:8787 (not 127.0.0.1) so containers can reach it via host.docker.internal:8787.

**Decisions worth not relitigating:**
- FG-330 was a misdiagnosis — runtime YAML and Zod schema both work correctly. Real issue is CLI inference routing.
- HTTP_PROXY/HTTPS_PROXY approach won't work — headroom proxy doesn't support CONNECT tunneling (returns 501).
- Unprefixed model IDs (anthropic.claude-sonnet-4-6) don't work — account requires inference profile IDs (us.anthropic.*) for on-demand throughput.
- CLAUDE.md trimmed ~24% this session — no content loss, just redundancy removal.

**Shipped (for reference):**
- 86ebd2d: CLAUDE.md trim (507→386 lines) + FG-330 investigation
- b7d81c0, 7e3ef29: FG-331 investigation docs
- 690c641: Fixed proxy upstream (was localhost:8788 dummy)
- 41c1751: host.docker.internal + 0.0.0.0 + /healthz fixes
- 560cda8: FG-331 final investigation notes
- FG-330: Closed (not a bug)
- FG-331: Filed (CLI inference routing bypasses endpoint override)

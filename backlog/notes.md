**Last session ended 2026-06-20** (full walk of the active backlog, one ticket at a time, deciding build-vs-close on each).

**Where we left off:** Walked all 26 active tickets interactively. Net: active backlog 26 → 8, all remaining are genuine (no stubs/speculation/gold-plating left). `main` is fully green (1540/1540, typecheck clean) — the FG-178 runner-detection regression that was red on the host got root-caused and fixed (FG-338). All work pushed to origin (through ecd4cb1). The disposition all session: verify each ticket's premise still holds (artifact exists? problem visible? consumer exists?) before building, and default to closing speculative/cosmetic/superseded work.

**Picked up next:**
1. **FG-258 (provider-agnostic runtime / pi) is the real forward thread** — it's the FG-291 baseline spine and dogfoodable for free here via `--profile pi-groq`. Its kept children are the work: FG-337 (capture final assistant msg when a clean runtime writes no result.json — build the fallback, sequence into the pi runtime work), then FG-253 (provider adapters) and FG-268 (local models) in the Walk/Run phases.
2. **FG-251 — the showcase `research-synthesis` workflow.** FG-291's "prove multi-agent value" item; sequenced behind FG-258 mixed-provider routing. Highest-leverage feature once the runtime split is solid.
3. **FG-190 items 2–9** — the remaining auth-profile correctness/cleanup (TOCTOU chmod, CDP timeout, wrong-tab capture, IPv6, cookie scoping, doc honesty). Item 1 (expiry/refresh-token) shipped. All low-pri pre-launch; pick up when convenient.

**External state to remember:**
- **Everything is pushed** — `origin/main` is at ecd4cb1; working tree clean, 0 commits ahead. (Note: this session pushed direct to main, which the user explicitly approved this time; default remains direct-to-main, no CI/PRs.)
- **Non-ticket thread — FG-158 corp-laptop Bedrock validation.** Code shipped; only the live `forge claude --bedrock` run on the corp laptop gates its close. A weekly cloud reminder routine fires Mondays 9am PT (claude.ai routine trig_01XFfSfNKSsPi3uUV1FaCmTx). Not actionable from this Mac.
- **pi runs FREE** via `--profile pi-groq` (GROQ_API_KEY, same shell; `gpt-oss-120b` does tool-calling, `llama-3.3-70b` mangles it). The forge-on-forge agent pipeline is unblocked (DEC-019) — engineer/test-engineer/doc-maintainer all ran cleanly against this repo all session.
- **Container vs host test discrepancy is gone** — FG-338 fixed the bash-3.2 `source <(...)` harness bug. The host suite is now authoritative and green; in-container runs match.

**Decisions worth not relitigating (this session's closes):**
- FG-141, FG-149, FG-150 — closed speculative (no observed problem / no consumer).
- FG-167 — removed orphaned `awaiting_human_input` status (never produced; superseded by `forge design`). ADR FORGE-DEC-020.
- FG-172 — closed; `request-changes` KEPT (correct for regeneration gates), implementation fix-cycles use review-loop.
- FG-222 + FG-311 — closed as gold-plating; stuck session tasks are 1 invisible straggler per project, nothing depends on them. No reaper.
- FG-223 — removed unused TaskContract feature; docs-impact helpers in contract.ts retained. ADR FORGE-DEC-021.
- FG-225/243/249/234/33/306/308 — closed (empty placeholder / overtaken by docs-as-pipeline / Fix A sufficient / polish / artifacts removed / done via #252+FG-332).
- FG-273 — epic closed; MVP acceptance met (orchestrator routes from compiled policy; route/raci CLI live). Provider-adapter remainder lives in FG-253.

**Shipped (for reference, git is canonical):**
- FG-167 remove awaiting_human_input (FORGE-DEC-020); FG-177 Playwright-E2E-vs-browser-tools split + anti-downgrade gate; FG-190 item1 auth-profile expiry/refresh-token fix; FG-223 remove TaskContract (FORGE-DEC-021); FG-28 per-run constraint scoping via `--tag`/`tags:` (+docs); FG-338 runner-detection test harness portability fix.
- FG-273 RACI PRD status flipped to shipped.

**Last session ended 2026-06-21.**

**Where we left off:** Deep in a git-worktrees research thread. Used the just-built `research-synthesis` workflow (Claude primary + Codex skeptic) to research "should forge always use worktrees", then sharpened the conclusion in conversation into two filed tickets (FG-345, FG-346). Last concrete action: promoted the research-role provider pins into the HOST model-policy and deleted the per-project override.

**Picked up next:**
1. **FG-345 — git worktrees for rw/blue write isolation.** The design is well-framed and ready to plan/build: the real driver is OS-level write-isolation parity with reds (blue agents currently share one rw `/project` mount, guarded only by a prompt-level file contract — collisions are SILENT corruption, not detectable merge conflicts). Cost is explicitly ruled out (~222ms/worktree, parallelized; the research's "880ms/batch" was a serial-summing error). The CENTRAL design question is the reconcile/merge step forge doesn't have today; secondary are dirty-state policy and red's-view (worktree snapshot vs live). Natural next implementation thread.
2. **FG-346 — interactive model-policy setup.** `forge setup` today is `copyFileSync(seed → host)` and asks nothing; FG-346 is the unbuilt interactive half of FG-252 (ask which providers+models via `forge providers doctor` detection, GENERATE the policy). Directly motivated by having to hand-craft routing this session. Body also flags the additive-vs-full-replacement project-policy drift problem to fold in.
3. **FG-258 thread continues:** FG-253 (provider adapters — argued PREMATURE this session: building an adapter abstraction from n=1 before a second operator surface exists; revisit when Codex operator files force the split) and FG-268 (pi local models). FG-340 (small: reword test-engineer seed so agents stop self-committing) is quick cleanup.

**External state to remember:**
- **HOST model-policy was hand-edited this session** (`~/.forge/model-policy.yml`, NOT a repo file): `overrides.agents` now pins `research-primary: claude-subscription`, `research-skeptic: codex-subscription`. This machine defaults research-synthesis to mixed Claude+Codex. The seed (`seeds/model-policy.example.yml`) keeps these as example-only. FG-346 exists to replace this hand-edit with generated config.
- **research-synthesis is DEPLOYED to `~/.forge`** (workflow + research-framer/research-primary/research-skeptic/synthesizer seeds, incl. the FG-343-hardened synthesizer). Fully functional end-to-end; produces a report at `<project>/research/<slug>.md`. `forge report <run-id>` re-renders any completed run.
- **Codex (openai/subscription) is live and proven** on this machine (`~/.codex/auth.json`) — ran as the skeptic in two real research-synthesis fan-outs.
- **FG-158 corp-laptop Bedrock validation** (carry-forward) — still gated on the live `forge claude --bedrock` run on the corp laptop; weekly Monday 9am PT reminder routine. Not actionable from this Mac.
- **pi runs FREE** via `--profile pi-groq` (GROQ_API_KEY); carry-forward.

**Decisions worth not relitigating:**
- **Worktrees (FG-345):** cost is a non-factor (negligible, and grpcfuse is not a NEW tax — the shared mount already uses it). The problem is silent lost-updates/corruption, NOT merge conflicts (worktrees CONVERT silent races into detectable merge conflicts). "Always" is viable since cost is nil; decide blue-rw-fanout-only vs truly-always alongside red's-view.
- **FG-344 report design:** deterministic render (no LLM), auto-fires on `gate.ts` completion (NOT runNext — synthesize is human-gated), lands at `<project>/research/<slug>-<shortid>.md`, `--out` overrides, `forge report` re-renders. The `docs` step was REMOVED from research-synthesis (research emits a report, never reconciles operator docs — the old docs step wrongly wrote findings into `docs/concepts.md`).
- **FG-343 synthesizer:** the load-bearing fix was removing the seed's "explore /project if inputs empty" instruction. `settings.json` tool restriction is NOT runtime-enforced under `--dangerously-skip-permissions` — constrain agent behavior via the seed prose, not the tool list.
- **Model routing belongs at host, not per-project copies:** project `.forge/model-policy.yml` is FILE-LEVEL REPLACEMENT (not merge), so hand-copied project policies drift from host.
- **Process:** ALL tests pass, always — a failing test on a `complete` result is an auto-reject; "pre-existing/unrelated" is never an excuse (saved to memory). Agents sometimes self-commit (broken partial commits) — check `git log` after every invoke. Trim a workflow step with `request-changes`, NOT by hand-editing run `result.json` (the runner reads from its persisted store, not your disk edit).

**Shipped (for reference, git is canonical):**
- FG-337 inferred-result fallback (clean runtime, no result.json → capture final assistant msg for narrative roles).
- FG-339 capability-aware routing (refuse structured roles on non-tool-capable models; pi guilty-until-`tool_capable:true`).
- FG-251 research-synthesis workflow (frame → dual independent research → synthesize; the FG-291 multi-agent showcase).
- FG-341 fix legacy migration corrupting the `frame` phase on every DB open.
- FG-342 write fan-out parent aggregate to disk so downstream steps can read it (the synthesis keystone).
- FG-343 synthesizer only synthesizes from provided evidence; flags absent inputs.
- FG-344 predictable deterministic research report artifact + `forge report`.
- Filed open: FG-340 (test-engineer self-commit wording), FG-345 (worktrees), FG-346 (interactive model setup).

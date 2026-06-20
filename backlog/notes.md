**Last session ended 2026-06-19** (fourth session that day — a backlog audit + cleanup grind).

**Where we left off:** Audited all 53 open tickets against the live codebase (5 parallel investigator agents) and closed 27 — stale/already-shipped, obsolete, parked-by-decision, or product-decided. Then proved DEC-019 (the #245 container-local node_modules shadow volume) actually unblocks the forge-on-forge AGENT pipeline — ran real `engineer` + `test-engineer` containers against this repo, host `better_sqlite3.node` survived (stayed Mach-O arm64) — and used the unblocked pipeline to ship two waves of work. Seeds were force-reinstalled at session end; `forge doctor` is green.

**Picked up next:**
1. **FG-158 — live Bedrock validation on the work laptop.** Code + docs landed and committed (`c93498b` / `80510de`), 1529 tests green, but the real Bedrock path (live SSO/STS, `startSsoWatchdog`, AWS_PROFILE → real profile, claude→Bedrock) was never exercised here. Run `forge claude --bedrock` on the corp laptop, confirm it arms without sourcing use-bedrock.sh, then close FG-158. This is the only thing gating its close.
2. **FG-306 item 3** — the leftover low-pri code item: `forge doctor` derives in-image CLI expectations from installed runtime YAMLs, not the (provider,auth)→runtime binding table, so a binding-table-reachable runtime with a missing/malformed seed YAML emits no `cli <x>` row. Only matters for a broken install; covered today. Either implement the diagnostic row or close FG-306 as not-worth-it.
3. **Resume closing bucket C (real features needing design).** 26 remain, all genuine builds/epics. Highest-leverage threads carried from before: FG-258 Walk items (FG-253 / FG-283 provider adapter surfaces, FG-308 project-local `.forge` config), and FG-337 → FG-268 (pi local/weak models). All now dogfoodable through the real agent pipeline OR `--profile pi-groq`.

**External state to remember:**
- **The forge-on-forge agent pipeline is unblocked (DEC-019, live-validated 2026-06-19).** Implementation forge-on-forge can now route through `engineer`→`test-engineer` (and docs through `documentation-maintainer`) — "implement directly" is now a process choice, not a corruption-safety rule. Shadow volume = `src/v2/spawn.ts` ~235 (darwin + rw only; escape hatch `FORGE_NO_NM_SHADOW=1`). Memory note updated. If a host binary ever flips to ELF after an agent run, that's a DEC-019 regression — check the mount, don't reflexively ban agents.
- **Parallel doc/seed agents on the SAME files race and silently clobber each other.** FG-247 and FG-272 both edited the 4 implementer seeds in parallel; FG-247 (last writer) wiped FG-272's edits. Caught by a post-run grep; re-ran FG-272 serially. Lesson: serialize agent edits that touch overlapping files.
- **Seeds were force-reinstalled** (`FORCE=1 ./scripts/install-seeds.sh`) so this session's seed edits (FG-247/272/160) are live in `~/.forge/agents/`. The old documentation-maintainer "drift" warning was just a stale host copy (now resolved), not a local edit. `forge doctor`: OK, no drift.
- **pi runs FREE on this machine** via the `pi-groq` profile (`provider: groq`, `runtime: pi-apikey`, `model: openai/gpt-oss-120b`) in `~/.forge/model-policy.yml` `allowed_profiles`. Run: `nvm use 24`; `export GROQ_API_KEY=…` (free key, no billing, SAME shell); `forge invoke <role> --profile pi-groq`. pi-oauth still bills the Anthropic API. `llama-3.3-70b-versatile` mangles tool-calling; `gpt-oss-120b` works.
- **Node 24 required** — `nvm use 24` (VS Code terminals keep landing on 20). FG-336 prints a clear preflight message now, but you still must switch.

**Decisions worth not relitigating:**
- The 27 closes this session were deliberate (audit-evidenced). FG-158 and FG-306 were kept OPEN on purpose (acceptance gate / leftover code item) — not oversights.
- FG-160 was scoped as a minimal seed-prose change (architect emits a Mermaid diagram), not a result-schema/dashboard feature. FG-247 was scoped to seed prose only; the optional `typecheck_run`/`format_checked` result-field enforcement was explicitly deferred (note it if ever filed).
- FG-42's new `security-audit.yml` example workflow was validated schema-correct against `src/v2/schema.ts` (real `gate: verdict` + mixed red authority + `on_reject`) and is installed on the host.

**Shipped (for reference):**
- Backlog audit: closed 20 (FG-191/173/185/232/245/250/112/73/130/148/184/203/88/60/61/129/293/294/282/283) + FG-270/FG-178/FG-310/FG-160/FG-247/FG-272/FG-42.
- FG-270: render `## Spec` section in the red task package (architect intent + tech-lead plan).
- FG-178: forge-test detects jest/vitest/node:test instead of hardcoding node:test.
- FG-158 (open): `forge claude --bedrock` + `.forge/project.json` auth — child-env injection, no shell sourcing.
- Wave 2 docs/seeds: FG-247 (mandatory project-aware type-check/format-check), FG-272 (fresh node_modules note), FG-310 (container isolation), FG-306 item 2 (README), FG-160 (architect Mermaid), FG-42 (how-to rewrite).

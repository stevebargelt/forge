**Last session ended 2026-06-19** (third session that day).

**Where we left off:** Started by answering "can we test pi with a free model on this machine?" — proved YES end-to-end (pi-apikey + the pi-groq profile + a free Groq key), then shipped the three forge-on-forge fixes that the debugging surfaced. FG-228 doubles as an FG-258 Walk advancement. All work pushed to origin/main (14d0cbc..82b31d2).

**Picked up next:**
1. Continue **FG-258** Walk with capable-model-friendly items: FG-253 / FG-283 (provider adapter surfaces) or FG-308 (project-local `.forge` config provisioning). Dogfood for free with `--profile pi-groq` (gpt-oss-120b).
2. **FG-337 then FG-268** (pi local models) — the weak-model stage, in that order. FG-337 (result.json fallback for models that can't tool-call) is a *soft prerequisite* for FG-268 only, not for FG-258 broadly.
3. Non-ticket thread: live-verify the **FG-228** codex/claude failure analyzers on a codex-authed machine. They're unit-tested against documented event shapes but never field-exercised here (no codex billing on this box; the pi path WAS proven live).

**External state to remember:**
- **pi runs FREE on this machine** via the `pi-groq` profile (`provider: groq`, `runtime: pi-apikey`, `model: openai/gpt-oss-120b`) in `~/.forge/model-policy.yml`, now in `allowed_profiles`. To run: `nvm use 24`; `export GROQ_API_KEY=…` (free key from console.groq.com, no billing); `forge invoke <role> --profile pi-groq`. The key must be in the SAME shell that runs forge.
- **pi-oauth still bills the Anthropic API** (does not consume the Claude subscription) → unusable on this machine. Free path is Groq api-key only.
- Free-Groq model caveat: `llama-3.3-70b-versatile` mangles pi's structured tool-calling (can't write result.json); `gpt-oss-120b` works. `moonshotai/kimi-k2-instruct` 404s on this Groq account (needs access).
- Refreshed `~/.forge/runtimes/pi-apikey.yml` + `pi-oauth.yml` from repo seeds (were stale via install-seeds `cp -n`). `forge doctor` still warns on one drifted PROSE seed (`agents/documentation-maintainer/CLAUDE.md`) — warn-only, may be an intentional local edit.
- Node 20/24 gotcha persists (the VS Code terminal landed on Node 20 this session). FG-336 now prints a clear "requires Node >=24" message instead of the cryptic ABI crash, but you still must `nvm use 24`.

**Decisions worth not relitigating:**
- FG-337 is NOT a gate before FG-258 — only a soft prereq for FG-268 (local/weak models). Capable models honor the result.json contract, so FG-258 Walk is dogfoodable now with gpt-oss-120b.
- pi's free path is settled as Groq free-tier api-key, NOT pi-oauth. The earlier "no free path / only local models" belief was disproven by a live run; the project memory note was corrected.

**Shipped (for reference):**
- FG-336 (4641ff9): CLI Node-version preflight — clear "requires Node >=24, run nvm use 24" + clean exit, before better-sqlite3 loads.
- FG-335 (1529752 + docs 2e68fcd): `forge doctor` seed-drift detection (installed ~/.forge vs running code); runtime drift = readiness FAIL, prose drift = warn. Caught a real stale pi-oauth.yml on this host.
- FG-228 (c835f12 + docs 069d93c): provider-agnostic `model_error` attribution — `analyzeProviderFailure` dispatches by log_format; codex (`type:error`/`turn.failed`) + conservative claude join the existing pi analyzer; wired into both failure branches in invoke + runNext.
- Filed FG-337 (output-contract fallback for weak models) — open, not started.

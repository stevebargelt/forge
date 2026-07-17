---
id: FG-589
type: story
status: done
title: "WITHDRAWN (not implemented): wire FG-580 AC-6 offline smoke into a required CI gate — originated from an unapproved offline requirement"
created: 2026-07-17
closed: 2026-07-17
---

> **WITHDRAWN (2026-07-17, recovery mode) — NOT IMPLEMENTED.**
> - This ticket originated from an **unapproved offline requirement**: the operator approved dashboard release
>   *bundling* only. Offline/CDN vendoring was advisor-generated hardening, not an operator decision.
> - It is **not required** by FG-580, FG-572, or FG-561 — none of their accepted acceptance criteria demand a
>   required offline-browser CI gate.
> - **No Chrome CI or branch-protection work is authorized.** No such work was done.
> - It was **not implemented** and its acceptance criteria were **not met**.
> - Historical text preserved below for the record.

---

**Surfaced by:** FG-580's review-loop, 2026-07-17 (round 2, run `run-review-loop-fg-580-fbe34f`).

## The gap

FG-580's AC-6 offline browser smoke (`dashboard/browser-tests/offline-boot.test.ts`) proves the
release-served dashboard boots and renders OFFLINE with esm.sh blocked — but it is **not part of any REQUIRED
CI check**. `.github/workflows/ci.yml`: the `test` job runs `npm run test:all`; the `test-extended` job runs
`npm run test:extended`, whose script **omits** the dashboard `test:browser` command. There is **no
Chrome-capable job in CI at all**.

Consequence: a future change that breaks the CSP, the import map, or the vendored client-module graph can
**merge with both required checks green** — the offline-boot guarantee silently regresses. AC-6 was verified
once, by a manual host run (real Chrome, 5/5), but nothing permanently enforces it.

## Fix

Wire `npm --workspace=dashboard run test:browser` (the AC-6 offline release smoke) into a **required**,
Chrome-capable CI verification:
- Add a CI job (or extend `test-extended`) that installs Chromium and runs the dashboard browser tier against
  a built release with CDN origins blocked. GitHub `ubuntu` runners can `apt-get install chromium-browser` or
  use `browser-actions/setup-chrome`; the agent image already bakes Chrome (FG-128) for the container path.
- Add the new check to **branch protection required contexts** on `main`. **This half is operator-domain** —
  branch protection is applied under the operator's GitHub session (`gh api .../branches/main/protection`),
  not agent-touchable. Register the check-run/job NAME (not the `CI / <name>` display form — see FG-495's
  live-hit note).

## Why this is a follow-up, not an FG-580 blocker

FG-580's AC-6 requires the smoke to EXIST and PASS ("server success alone is insufficient") — it does, and it
was host-verified 5/5. FG-580's core invariant (the dashboard bundles + boots offline from a promoted release,
enforced at build AND promote) is preserved and verified. Making the smoke a *permanent required CI gate* is
platform-hardening beyond the AC, and it requires operator branch-protection action either way.

## Acceptance
- A required, Chrome-capable CI check runs the AC-6 offline release smoke on every PR to `main`; a broken
  CSP/import-map/vendored-graph makes it RED and blocks merge.
- Registered in `main` branch protection (operator action) using the check-run job name.
- A mutation proof: a deliberately broken vendored import makes the CI check red.
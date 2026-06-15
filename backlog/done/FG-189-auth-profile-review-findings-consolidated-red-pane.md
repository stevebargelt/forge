---
id: FG-189
type: story
status: done
title: "Auth-profile review findings (consolidated: red panel + independent review)"
---

**Closed:** 2026-05-29.

Combined, code-verified findings from forge's own red panel (red-security 0.78 / red-backend 0.88, both verdict FAIL) AND an independent external agent review of the #176 auth-profile code. Verified against source 2026-05-29. Supersedes #188.

**Priority is CORRECTNESS / CLEANUP, not security-urgent.** Per product owner (2026-05-29): zero users, security hardening deprioritized pre-launch — track these, fix genuine correctness bugs, revisit hardening before onboarding real users. Reviewers CONFIRMED the load-bearing invariants are sound: reds never receive the credential (runOneRed passes no profile), and sanitizeProfileName blocks path traversal.

**Correctness bugs (worth fixing):**
1. TOCTOU write-then-chmod — credential file briefly at umask default before chmod. Two sites: writeProfile (src/util/auth-profiles.ts) + staged copy (src/v2/auth-state.ts). Fix: writeFileSync(path, data, { mode: 0o600 }), ideally temp-file + rename.
2. [NEW, verified] Over-broad EXPIRY → premature expiry. profileExpiry (auth-profiles.ts:133/136) does Math.min over ALL cookie expires; an unrelated short-lived cookie (CSRF/analytics) marks a still-valid auth profile expired. Fix: prefer localStorage/JWT auth expiry when present; only consider likely auth/session cookies.
3. [NEW, verified] IPv6 [::1] not reconciled. new URL("http://[::1]:3000").hostname === "[::1]" (brackets) but LOCALHOST_HOSTS has "::1" → ::1 origins skip the localhost→host.docker.internal rewrite. Fix: normalize brackets or include both forms. (Low impact; rare.)
4. CdpSession.send has no timeout — `forge auth-profile login` hangs forever if Chrome/CDP stalls after Enter. Fix: per-call timeout that rejects + close the socket.
5. [NEW, verified] Wrong-tab capture. cdp-capture.ts:168 picks the FIRST page target. Mitigated by the dedicated-browser launch (one tab), but if the user opens tabs it can snapshot the wrong one. Fix: prefer the page whose origin matches the requested --url.
6. Cookie leading-dot domain (.localhost) not reconciled (auth-profiles.ts). Zero impact for the current localStorage-only app; real for cookie-based apps. Normalize cookie domains before reconciliation.

**Cleanup:**
7. Staged auth-state.json persists in the run dir after the run. Stage outside taskDir and/or unlink after the container exits.
8. Network.getCookies captures cookies from ALL origins, not just the target (over-broad capture). Scope to the target origin (pairs with #2).

**Documentation honesty (cheap, do it — NOT a code vuln):**
9. Correct overclaiming language. The injected token IS readable by the (trusted) primary agent inside its container — it can `cat /forge-auth/state.json`. Accurate guarantee: "never in prompts, logs, result.json, or the project mount" — NOT "the agent never holds/sees the credential." Fix the ADR (2026-05-28_auth-profile-cdp-localstorage-injection.md) + any commit-summary phrasing. This is NOT a vulnerability within forge's trust model (container boundary = trust line; trusted primaries; reds correctly excluded). A separate injector-process boundary for true isolation is possible but NOT warranted at this stage — explicitly out of scope.

**By-design (NOT defects — recorded so they aren't re-raised):**
- Pipeline auth scoping is a role allowlist incl engineer + frontend-specialist (they do UI visual verification). A workflow-level needs_auth: true flag is an optional refinement (tracked in #184), not a bug. The independent review rated this medium; it's by-design.

Provenance: forge red panel + independent external agent review, merged and code-verified by the orchestrator.
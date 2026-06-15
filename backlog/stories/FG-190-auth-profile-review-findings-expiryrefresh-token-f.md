---
id: FG-190
type: story
status: active
title: Auth-profile review findings + expiry/refresh-token fix (consolidated)
---

Combined, code-verified findings from forge's red panel (red-security 0.78 / red-backend 0.88, both FAIL) + an independent external agent review of the #176 auth-profile code, PLUS the refresh-token expiry gap found in use. Verified against source 2026-05-29. Supersedes #189 (and #188).

**Priority is CORRECTNESS / CLEANUP, not security-urgent.** Per product owner (2026-05-29): zero users, security hardening deprioritized pre-launch; track these, fix genuine correctness bugs, revisit hardening before real users. Reviewers CONFIRMED the load-bearing invariants are sound: reds never receive the credential (runOneRed passes no profile), sanitizeProfileName blocks path traversal.

**HIGHEST VALUE — expiry logic is wrong, and it artificially kills usable sessions:**
1. Expiry is computed wrong in TWO ways, both in profileExpiry / profileStatus (src/util/auth-profiles.ts:118-136):
   (a) **Ignores the refresh_token.** A captured Supabase bundle contains access_token (~1h), expires_at, AND refresh_token. forge gates on the access token's 1h expires_at and hard-fails after that — but the injected bundle includes the refresh_token, and the app's Supabase client (autoRefreshToken on) silently mints new access tokens on load. So the agent's real session lives as long as the REFRESH token (days/weeks), not 1h. forge declaring the profile dead at 1h is the actual flaw — it makes "capture once" far less useful than it is. Fix the gate: access valid → OK; access expired BUT refresh_token present → proceed (browser refreshes on load), warn at most; access expired AND no refresh_token → fail.
   (b) **Over-broad min.** profileExpiry does Math.min over ALL cookie `expires` (line 133); an unrelated short-lived cookie (CSRF/analytics) marks a still-valid auth profile expired. Fix: derive expiry from the auth-token/JWT (and refresh_token presence), not arbitrary cookies.
   Caveat to document: Supabase rotates refresh tokens — if the human keeps actively using the same login after capture, rotation can invalidate the captured refresh_token. Cleanest capture = log in fresh in the forge window; long-term an app test-login endpoint sidesteps it (v2, #176). Don't build server-side refresh (needs the anon key, not captured) — rely on in-browser auto-refresh.

**Other correctness bugs (worth fixing):**
2. TOCTOU write-then-chmod — credential file briefly at umask default before chmod. writeProfile (auth-profiles.ts) + staged copy (auth-state.ts). Fix: writeFileSync(path, data, { mode: 0o600 }), ideally temp-file + rename.
3. [verified] IPv6 [::1] not reconciled. new URL("http://[::1]:3000").hostname === "[::1]" (brackets) but LOCALHOST_HOSTS has "::1" → ::1 origins skip the localhost→host.docker.internal rewrite. Fix: normalize brackets or include both. (Low impact.)
4. CdpSession.send has no timeout — `forge auth-profile login` hangs forever if Chrome/CDP stalls after Enter. Fix: per-call timeout that rejects + close the socket.
5. [verified] Wrong-tab capture. cdp-capture.ts:168 picks the FIRST page target. Mitigated by the dedicated-browser launch; fix: prefer the page whose origin matches --url.
6. Cookie leading-dot domain (.localhost) not reconciled (auth-profiles.ts). Zero impact for the localStorage-only app; real for cookie-based apps. Normalize domains before reconciliation.

**Cleanup:**
7. Staged auth-state.json persists in the run dir after the run. Stage outside taskDir and/or unlink after the container exits.
8. Network.getCookies captures cookies from ALL origins, not just the target (over-broad capture). Scope to the target origin (pairs with 1b).

**Documentation honesty (cheap, do it — NOT a code vuln):**
9. Correct overclaiming language. The injected token IS readable by the (trusted) primary agent inside its container (`cat /forge-auth/state.json`). Accurate guarantee: "never in prompts, logs, result.json, or the project mount" — NOT "the agent never holds/sees the credential." Fix the ADR + commit-summary phrasing. NOT a vuln within forge's trust model (container boundary = trust line; reds correctly excluded). A separate injector-process boundary is possible but NOT warranted now — out of scope.

**By-design (NOT defects — recorded so they aren't re-raised):**
- Pipeline auth scoping is a role allowlist incl engineer + frontend-specialist (UI visual verification). A workflow needs_auth: true flag is an optional refinement (#184), not a bug.

Provenance: forge red panel + independent external review + in-use refresh-token finding, merged and code-verified by the orchestrator.
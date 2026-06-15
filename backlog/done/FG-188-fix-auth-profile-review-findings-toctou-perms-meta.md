---
id: FG-188
type: story
status: done
title: Fix auth-profile review findings (TOCTOU perms, --meta bypass, CDP hang, cookie-dot)
---

**Closed:** 2026-05-29.

**From the red panel review of the #176 auth-profile code (2026-05-29).** Two reds (red-security 0.78, red-backend 0.88) converged on these REAL, unfixed defects. None critical for single-user macOS, but all legit and cheap:

1. **TOCTOU write-then-chmod (medium, both reds)** — `writeFileSync(path, data)` then `chmodSync(path, 0o600)` leaves the credential file briefly at umask default (world-readable on a shared host). Two sites: `writeProfile` (src/util/auth-profiles.ts) and the staged reconciled copy (src/v2/auth-state.ts). Fix: pass `{ mode: 0o600 }` to writeFileSync so perms are set at creation.
2. **--meta authProfile bypass (low, red-security)** — `forge new --meta '{"authProfile":"x"}'` injects the key into run metadata via the inputs spread (startRun), bypassing the up-front existence/expiry validation in new.ts (which only checks --auth-profile). Not a security hole (per-step resolution still fail-fasts), but defeats fail-fast-at-creation. Fix: validate metadata.authProfile too, or strip it from --meta.
3. **CdpSession.send has no timeout (medium, both)** — registers a pending promise then ws.send with no error/timeout handling; captureViaBrowser hangs forever if Chrome stops responding after the user presses Enter. Fix: bound send() with a timeout that rejects.
4. **Cookie leading-dot domain miss (red-be high / red-sec low)** — reconcileStateForContainer only matches exact `localhost`/`127.0.0.1`; a `.localhost` cookie domain isn't rewritten. Zero impact for the current localStorage-only app (no cookies), real for cookie-based apps. Calibration note: red-be over-rated this high.
5. **Staged auth-state.json never cleaned up (low, both)** — the reconciled copy persists in the run dir after the run. Lower priority (run dirs aren't auto-cleaned anyway).
6. **Network.getCookies over-broad (low, red-security)** — capture grabs cookies from all origins, not just the captured app's. Scope to the target origin.

Reds CONFIRMED the load-bearing invariants are sound: reds never receive the credential (runOneRed passes no profile), and sanitizeProfileName blocks path traversal. No hallucinated findings.

Recommended order if picked up: #1 (TOCTOU) + #2 (--meta) + #3 (CDP timeout) are quick and worthwhile; #4/#5/#6 lower priority.
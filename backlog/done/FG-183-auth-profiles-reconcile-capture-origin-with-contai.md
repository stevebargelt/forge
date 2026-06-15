---
id: FG-183
type: story
status: done
title: "Auth profiles: reconcile capture origin with container-reachable origin for host-served apps"
---

**Closed:** 2026-05-29.

**Found proving #176 end-to-end in a real container.** A captured profile records the origin the human logged in at (e.g. `http://localhost:3000`). But an agent container on macOS cannot reach the host's `localhost` — it must browse `http://host.docker.internal:3000`. The browser-tools injector guards localStorage by `location.origin` (the domains allowlist), so when the agent browses host.docker.internal but the profile origin is localhost, injection silently no-ops and the agent lands logged-out (which, per #176 finding #2, renders an empty shell, not a login redirect — a false "app broken").

**Proof workaround used (do not ship as the UX):** hand-derived a `qa-admin-docker` profile by rewriting `http://localhost:3000` → `http://host.docker.internal:3000` (and cookie domain localhost → host.docker.internal). The Supabase session JWT is origin-agnostic, so the same token authenticated fine. Run passed: agent reported logged_in, steve@bargelt.com, steve-1, teams visible.

**What forge should do (options to weigh):**
- On copy into the authed container, if the profile origin host is `localhost`/`127.0.0.1` and the app is host-served, rewrite the origin (and cookie domains) to `host.docker.internal` in the in-container copy — transparent, no second profile. Needs a signal that the target is host-served (heuristic, or a flag on the profile / invoke).
- OR capture/store the profile under the container-reachable origin from the start (capture via host.docker.internal — but the human logs in on localhost).
- OR pass `--network host` so container localhost maps to host localhost (Docker Desktop 4.34+, macOS-gated; forge spawn has no network flag today — separate change).
- For PUBLIC staging/prod apps (real DNS, reachable identically from host and container) this is a non-issue; the gap is specific to localhost-served dev apps.

**Reachability is NOT the gap:** host.docker.internal:3000 returns 200 from the agent image with no --add-host (Docker Desktop auto-provides it). Only the origin mismatch needs solving.

Relates to #176 (auth profiles), #181 (pin browser-tools), #182 (generic env var).
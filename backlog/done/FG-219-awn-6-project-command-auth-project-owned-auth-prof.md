---
id: FG-219
type: story
status: done
title: "AWN-6 project-command-auth: project-owned auth profile (runs project login command to produce storageState)"
---

**Closed:** 2026-05-30. Commit `853b418`.

docs/agentic-workflow-next-steps.md §6. Authenticated browser work where the PROJECT owns credentials/login, forge owns scoping/mounting/redaction/freshness/lifecycle.

DIRECTLY SOLVES the gap surfaced 2026-05-30: a project with programmatic QA logins (e.g. Pixtron) has no way to declare its login to forge. Today programmatic login is the documented DEFAULT but is entirely project-side (Playwright globalSetup) with no forge-side declaration; the captured-session auth-profile (#176) is the only forge-owned path. AWN-6 adds the missing middle: a declared project-command profile.

Scope (new auth_profile kind):
  auth_profiles:
    qa:
      kind: project-command
      command: npm run e2e:auth
      storage_state: .playwright/.auth/qa.json
      required_env: [E2E_SUPABASE_EMAIL, E2E_SUPABASE_PASSWORD]
      roles: [test-engineer, manual-qa, frontend-specialist]
- Project owns credentials, login flow, token refresh, cleanup.
- Forge owns role scoping, read-only mount, redaction, freshness checks, lifecycle events.
- Keep the captured-session profile (#176) as the manual fallback.

Acceptance:
- Forge checks required_env var NAMES without printing values.
- Forge runs the auth command before browser-capable tasks that request the profile.
- Forge mounts the produced storage_state read-only into the container.
- Reds do NOT receive auth state by default.
- forge show reports auth setup success/failure without exposing secrets.

Relates to #184 (auth-profile polish). First of the broadening trio (AWN-6/7/8).
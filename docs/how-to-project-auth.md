# How-to: project-provided auth for authenticated testing (AWN-6)

When an agent needs to test an app **logged in**, the preferred path is a
**project-command auth profile**: forge runs *your project's own login* to mint a
Playwright `storageState`, then mounts it read-only into the container. The
project owns credentials, the login flow, token refresh, and cleanup; forge owns
role scoping, freshness, read-only mounting, and redaction.

This is distinct from the captured-session profile (`forge auth-profile login`,
#176), which is the fallback for apps with **no scriptable login** (third-party
SSO/MFA).

## Declare it

Create `<project>/.forge/auth-profiles.yml`:

```yaml
auth_profiles:
  qa:
    kind: project-command
    command: npm run e2e:auth          # your login → writes storage_state
    storage_state: .playwright/.auth/qa.json
    required_env:                      # checked by NAME (values never printed)
      - E2E_SUPABASE_EMAIL
      - E2E_SUPABASE_PASSWORD
    roles:                            # which roles may receive it (reds NEVER do)
      - test-engineer
      - manual-qa
      - frontend-specialist
```

Your `command` is any script that authenticates a dedicated test user and writes
a Playwright `storageState` JSON to `storage_state` (e.g. a Playwright
`globalSetup` doing `signInWithPassword` → `storageState`).

## Use it

```bash
forge invoke test-engineer --task "..." --auth-profile qa --project /path/to/app
```

Forge will, before spawning the container:

1. Check the `required_env` var **names** are set (it never reads or logs values).
2. Run `command` in the project dir.
3. Verify `storage_state` was produced.
4. Reconcile localhost origins for container access and stage a forge-owned
   **mode-600** copy mounted read-only at `/forge-auth/state.json`.

If any step fails the task fails fast with a secret-free reason
(`forge show <task>` reports it). The pipeline (`forge new feature`) honors the
same profiles for browser-capable steps.

## Guarantees

- **Reds never receive auth state** — regardless of the `roles` list.
- The agent never sees the credential; it gets only the staged session.
- Errors and the task manifest never contain credential material (the manifest
  auth block is booleans-only: `profileRequested` / `stateMounted`).

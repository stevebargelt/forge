# Remote Board over Cloudflare Tunnel + Access (FG-784)

This guide covers running the [Remote Board](SCHEMA-CONTRACT.md#remote-board-fg-781)
on a **public hostname** — reachable from any browser — while keeping it locked behind
**Cloudflare Access**, using a **Cloudflare Tunnel** as the transport in front of Forge's
loopback-only remote listener. It is written for operation on the single host that runs Forge.

The Remote Board itself (FG-781) ships the mode, the read-only projection, and a fail-closed
identity interface, but no transport — until you wire one, every remote request is refused.
[Tailscale Serve (FG-782)](how-to-remote-board-tailscale.md) is the tailnet-private transport;
FG-784 is the **public-hostname** transport, and its safety rests **entirely** on a Cloudflare
Access policy in front of the tunnel.

> **A tunnel without an Access policy is unsupported.** A public hostname fronted by a bare
> `cloudflared` tunnel with **no Access policy** is a public, unauthenticated service — Forge
> refuses to set that up and never trusts it. See
> [Authenticated hostname vs. public service](#authenticated-hostname-vs-public-service).

## What you get, and the boundary it keeps

An authorized user opens `https://<your-hostname>` from any browser, authenticates at the
Cloudflare Access login, and sees the read-only board for the **one** project their verified
identity (email) is mapped to — nothing else, and no way to change anything.

Two properties hold no matter what a request carries:

- **Forge stays bound to loopback.** The remote backend binds `127.0.0.1:8025` and the local
  dashboard binds `127.0.0.1:8024`; neither is ever widened. The Cloudflare Tunnel is a proxy
  *in front of* the loopback endpoint — it does not change what Forge binds. There is no
  `--remote-host` flag and no `FORGE_DASHBOARD_REMOTE_HOST` env var, by design.
- **Identity is proven by cryptographically validating the Access token, never from a header on
  its face.** Cloudflare Access terminates at the edge, mints a signed
  `Cf-Access-Jwt-Assertion` token from the browser's `CF_Authorization` cookie, and `cloudflared`
  forwards it as a header to `http://127.0.0.1:8025`. A header's **presence is never
  authentication** — a local process could set the same header with a forged token. So on every
  request the adapter (`dashboard/src/remote/cloudflare/adapter.ts`, kind `cloudflare-access`):
  1. requires the backend socket peer to be **loopback** — a request that did not arrive through
     the local `cloudflared` proxy is refused before any token is read;
  2. reads the `Cf-Access-Jwt-Assertion` value as a **candidate to be cryptographically
     confirmed**, never trusted on its face; and
  3. **verifies** the token against the team's JWKS: signature (RS256 by default; ES256 only if
     you opt in — `alg:none` and all HS\* are rejected structurally), issuer
     (`https://<team>.cloudflareaccess.com`), audience (the Access application **AUD** tag), and
     the temporal claims `exp`/`nbf`/`iat`.

  A missing, expired, not-yet-valid, wrong-audience, wrong-issuer, invalid-signature, replayed
  (outside the token's own `exp`/`nbf` window), or spoofed-header token gets **no project data**.
  Because the one header the adapter consults is cryptographically confirmed (not ignored), the
  resolution records it as a *confirmed identity header* (`cf-access-jwt-assertion`) in its audit
  trail.

## Prerequisite: this is a single-operator host

The Remote Board's threat model assumes the Forge host has **one** operator. Any local process
that can reach `127.0.0.1:8024`/`:8025` already has full database and filesystem access to Forge;
the loopback boundary is not a defense against other users on the same machine. Do **not** run
this on a shared/multi-user host. This is a hard prerequisite, not a recommendation.

## Prerequisites on the host

Before you start, on the machine running Forge:

1. **Install `cloudflared`** and make sure it is on your `PATH` (`cloudflared --version`).
2. **Create a Cloudflare Tunnel** and its DNS route for your public hostname, and have
   `cloudflared`'s tunnel credentials on the host (this is Cloudflare's own
   `cloudflared tunnel login` / `cloudflared tunnel create` flow). Forge does **not** create the
   tunnel or hold its credentials.
3. **Create a Cloudflare Access application** protecting that public hostname with an identity
   policy, and note its **Audience (AUD) tag** and your **team domain**
   (`<team>.cloudflareaccess.com`). Without an Access application in front of the hostname, the
   tunnel is a public unauthenticated service and Forge refuses it.

`forge remote cloudflare doctor` (below) checks `cloudflared` presence, that a team domain and a
well-formed AUD are supplied, and that the team's JWKS certs endpoint is reachable, before you
change anything.

### Cloudflare configuration you arrange yourself

Forge does **not** administer your Cloudflare account, tunnel, or Access application — you arrange
those. What Cloudflare must provide:

- **A Cloudflare Tunnel** whose ingress points **only** at this host's loopback board. Forge
  writes that ingress config file for you; you run `cloudflared tunnel run` against it.
- **A Cloudflare Access application protecting the public hostname** with an identity policy —
  this is the authentication boundary. A public hostname with no Access policy is refused.

Cloudflare reachability is necessary but **not** sufficient: a user who can authenticate at the
Access edge still gets no project data until you map their verified email in the Forge identity
file below. Reaching the edge is Cloudflare's job; authorization is Forge's.

## Step 1 — Start the Remote Board with the Cloudflare transport

The transport is selected once at boot by an explicit env var. Absent or unrecognized, no adapter
is selected and every request is refused (the FG-781 default) — this is the single switch that
turns identity verification on.

```bash
FORGE_DASHBOARD_REMOTE_TRANSPORT=cloudflare \
  forge dashboard start --remote
```

- `--remote` (or `FORGE_DASHBOARD_REMOTE=1`) opts into remote mode and boots the loopback remote
  listener on `:8025`.
- `FORGE_DASHBOARD_REMOTE_TRANSPORT=cloudflare` selects the Cloudflare Access adapter. The value
  is trimmed and case-insensitive; anything other than `tailscale`/`cloudflare` (including
  absent/empty) selects **no adapter**, so the board refuses every request.
- To use a non-default remote port: add `--remote-port <n>` (threads
  `FORGE_DASHBOARD_REMOTE_PORT`). It must differ from the local dashboard port (`8024`).

The bind stays loopback regardless of the transport; selecting an adapter never touches the bind
host.

The adapter reads its **non-secret** boot config — the Access team domain and AUD tag — from the
Forge-owned state file that `setup` writes (below), **not** from env vars. **If no team domain and
AUD are recorded, the adapter refuses every request** — it never degrades to accepting any issuer
or audience.

## Step 2 — Author the identity → authorization mapping

Authorization is an operator-authored file, kept separate from the identity channel, and it is the
**same file** the Tailscale transport uses — Cloudflare gains no separate vocabulary. It maps a
**verified login (email)** to exactly one project key and its capabilities (read-only in this
release).

Create `~/.forge/remote-board-identity.yml` (or `$FORGE_HOME/remote-board-identity.yml` if you set
`FORGE_HOME`):

```yaml
# Remote Board identity → authorization mapping.
# Maps a verified login to ONE project's read-only board.
version: 1
identities:
  - login: steve@example.com      # the email the Access JWT is verified to carry
    project: pk-forge             # the Forge project key this login may read
    capabilities: [read]          # closed vocabulary — only `read` is valid today
  - login: teammate@example.com
    project: pk-otherproject
    capabilities: [read]
```

Field rules (all **fail closed** — every malformed case grants *less*, never more):

- `version` — must be `1` (an absent version reads as `1`). A file declaring a different version
  is rejected **whole** (nobody is granted anything).
- `login` — the email as it appears in the verified Access token's identity claim. It is trimmed
  and lower-cased on both sides, so case never causes an accidental lockout. Blank or non-string
  logins are dropped. A login declared **more than once** is *poisoned* — it gets **no** grant,
  because two lines for one identity is ambiguous intent and must never be silently merged into a
  wider grant.
- `project` — the Forge project key (e.g. `pk-…` / `repo-…`). The board's scope (which directories
  are read) is resolved **server-side** from this key against the project registry; the file never
  names directories. A grant naming an unregistered project yields no data.
- `capabilities` — a non-empty list drawn from the **closed** vocabulary. Today the only member is
  `read`. Any unknown capability (`write`, `mutate`, a typo) *taints the whole entry* and drops it.

An entry that fails any rule is dropped; the rest of the file still loads. A missing file, and a
login not in the file, are indistinguishable to the board: both mean **no grant**. There is no
default-allow.

You can find a project's key with `forge projects list` (or the project's `.forge/config.yml`
`project_key`).

## Step 3 — Inspect with `doctor` (no changes made)

`doctor` is read-only. Run it before touching anything:

```bash
forge remote cloudflare doctor \
  --hostname board.example.com \
  --team myteam.cloudflareaccess.com \
  --aud <access-application-aud-tag>
forge remote cloudflare doctor --json    # structured
```

(The `--hostname`/`--team`/`--aud` flags fall back to the `FORGE_REMOTE_CLOUDFLARE_HOSTNAME` /
`FORGE_REMOTE_CLOUDFLARE_TEAM` / `FORGE_REMOTE_CLOUDFLARE_AUD` env vars if omitted.)

It reports:

- **Prerequisites** — `cloudflared` on PATH, the public hostname, the Access team domain, the
  Access application AUD, and whether the team's **JWKS certs endpoint is reachable**
  (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`).
- **Proposed tunnel target** — `https://<your-hostname> → http://127.0.0.1:8025` and the path of
  the Forge-owned ingress config it would write.
- **Direct-origin boundary** — the notes explaining that the board binds loopback only, that the
  tunnel is the only way in, and that a bare tunnel with no Access policy is refused and never
  trusted.
- **Identity mode** — the selected transport (`FORGE_DASHBOARD_REMOTE_TRANSPORT`) and the path to
  the identity mapping file. If the transport is unset, doctor says so: the board refuses every
  request until you set it.
- **Required Cloudflare configuration** — the tunnel + Access-application list you arrange
  yourself.

It exits `0` when the host is ready and `1` when setup would refuse (missing `cloudflared`, no
team, a malformed AUD, an unreachable JWKS endpoint, or a hostname with no Access policy).

## Step 4 — Apply the ingress config with `setup`

```bash
forge remote cloudflare setup --hostname board.example.com --team myteam.cloudflareaccess.com --aud <aud> --dry-run    # inspect only — writes NOTHING
forge remote cloudflare setup --hostname board.example.com --team myteam.cloudflareaccess.com --aud <aud>              # preview the plan; still writes nothing
forge remote cloudflare setup --hostname board.example.com --team myteam.cloudflareaccess.com --aud <aud> --confirm    # write the Forge-owned ingress config + state record
```

- `--dry-run` performs **zero** disk mutations. It is enforced two ways: the plan carries an empty
  write set, and the `cloudflared` runner it is handed throws if any mutating `cloudflared` command
  is even attempted — a bug cannot mutate under `--dry-run`.
- Without `--confirm`, `setup` only **previews** what it would write; it changes nothing.
- With `--confirm`, and only after prerequisites pass (team + well-formed AUD supplied, JWKS
  endpoint reachable, an Access-protected hostname), `setup`:
  1. writes the Forge-owned `cloudflared` **ingress config file** (whole-file ownership) pointing
     the tunnel at `http://127.0.0.1:8025`; and
  2. records the exact deployment in `~/.forge/remote-board-cloudflare-state.json` (owner-only
     `0600`).
- `setup` **refuses** a public hostname with no Access policy and a tunnel-without-Access
  configuration (AC4), and it **never requires, prints, or persists** a Cloudflare API token or
  `cloudflared` tunnel credentials — the team domain, AUD tag, and hostname are all public
  identifiers.
- `setup` does **not** run the tunnel. After it writes the ingress config, **you** run
  `cloudflared tunnel run` against that config. Forge holds no Cloudflare credentials.

Optional flags: `--tunnel <name>` (the tunnel name to reference in the owned ingress config),
`--credentials-file <path>` (path to `cloudflared`'s tunnel credentials — written into the owned
config only, never persisted by Forge), and `--config <path>` (override the owned ingress config
path; default is under `FORGE_HOME`).

The state file and ingress config are machine-authored and machine-read — you inspect them but do
not hand-edit them (unlike the identity mapping). They exist so `disable` can be surgical.

## Verify

1. `forge remote cloudflare doctor` shows `READY` and the active Forge deployment.
2. From any browser, open `https://<your-hostname>` — authenticate at the Cloudflare Access login;
   an authorized email sees its project's board.
3. Confirm the boundary holds:
   - A user whose email is **not** in the mapping file gets the `unauthorized` board (no project
     data).
   - A direct request to `http://127.0.0.1:8025` with a forged or absent `Cf-Access-Jwt-Assertion`
     — a token that does not verify against the team JWKS — gets **no** project data.
   - Ports `8024` and `8025` are loopback-only: `curl http://<lan-ip>:8024` and `:8025` do not
     connect. Only the Access-gated public hostname reaches the board.

## Revocation and the token-lifetime bound

Two revocation layers apply. One is honored **live**; the other is bounded by the Access token
lifetime — set short Access sessions.

- **Mapping edit — live, on the next request.** Authorization is re-read from the mapping file on
  **every request**; there is no long-lived identity cache. Delete (or comment out) a `login`
  entry in `~/.forge/remote-board-identity.yml` and their next request gets no data — no Forge
  restart. Changing their `project` line is live the same way.
- **Access policy change / logout — bounded by the token lifetime.** Forge holds **no** session or
  cookie state that outlives the Access token, so it mints nothing longer-lived than the token.
  But a token that is already valid keeps verifying until its own `exp` — Forge cannot revoke a
  Cloudflare-signed token before it expires (replay is `exp`/`nbf`-bound by design; there is no
  jti ledger). So revoking a user at the **Access** layer (removing them from the Access policy,
  or their logging out) takes effect **within one Access token lifetime**, not instantly.

  **Recommendation (AC6):** configure a **short Access session duration** for the application so
  this window is small. To force a browser session to end immediately, use Cloudflare Access's own
  **logout endpoint**: `https://<team>.cloudflareaccess.com/cdn-cgi/access/logout`. Forge has no
  logout of its own to offer because it holds no session — clearing the Access session is the
  logout.

Either layer denies; the mapping layer is instant and the Access layer is bounded by the token
lifetime.

## Disable / reset

```bash
forge remote cloudflare disable          # remove ONLY the Forge-owned ingress config + state record
forge remote cloudflare disable --json
```

`disable` removes **exactly** the ingress config file Forge authored and the Forge state record —
nothing else. It does **not** delete the Cloudflare Access application, the tunnel, or
`cloudflared`'s credentials, and it does **not** change the local `:8024` dashboard. If there is no
recorded Forge deployment, it does nothing (rather than a wrong or blanket removal).

Stopping the tunnel itself (`cloudflared tunnel run`) and removing the Access application are
Cloudflare-side actions you take yourself. To also stop the remote listener, stop the dashboard or
restart it without `FORGE_DASHBOARD_REMOTE_TRANSPORT` / `--remote`.

## Recovery

Loss of Cloudflare or the host makes the board **unavailable** — it never falls back to a public
unauthenticated bind:

- If the team's JWKS endpoint is unreachable and the key cache is empty/stale, the adapter has no
  usable keys and every request gets no data (fail closed) — it never accepts an unverifiable
  token.
- If `cloudflared` is not running, the public hostname simply does not reach the board; the
  loopback board is unaffected.
- The local `:8024` dashboard keeps working throughout — remote transport problems never degrade
  local operation.

To restore access after an outage: bring `cloudflared` back up (`cloudflared tunnel run` against
the owned ingress config), confirm with `forge remote cloudflare doctor`, and re-run
`forge remote cloudflare setup --confirm` if the ingress config was lost.

## Authenticated hostname vs. public service

A Cloudflare Tunnel terminates on the **public internet**. The difference between a safe Remote
Board deployment and a data leak is entirely the **Cloudflare Access policy** in front of it:

- **An authenticated public hostname** — a tunnel whose hostname is protected by a Cloudflare
  Access application — only reaches the board with a valid, edge-minted Access token. The public
  hostname is useless without one; Forge verifies that token cryptographically before returning
  any data. This is the only supported deployment.
- **A public unauthenticated service** — a bare `cloudflared` tunnel with **no Access policy** —
  exposes whatever it fronts to anyone on the internet. Forge treats this as unsafe:
  `doctor`/`setup` **refuse** to proceed without a team domain and a well-formed AUD (the markers
  of an Access application), and even if such a tunnel were stood up out of band, the adapter
  refuses every request because there is no verifiable Access token.

If you want public reachability, put a Cloudflare Access policy in front of it. Never expose the
board on a bare tunnel.

## Related

- [Remote Board contract (FG-781/FG-784)](SCHEMA-CONTRACT.md#remote-board-fg-781) — env vars,
  identity-mapping and Cloudflare state-file contracts, projection DTOs, loopback-only ports.
- [Remote Board over Tailscale Serve](how-to-remote-board-tailscale.md) — the tailnet-private
  transport that shares the same identity-mapping file and loopback boundary.
- [Remote Board section in the dashboard README](../dashboard/README.md#remote-board-fg-781).
- [Secret hygiene and redaction](redaction.md#remote-board-free-text-fg-781) — how free-text
  fields are swept before they cross the remote boundary.

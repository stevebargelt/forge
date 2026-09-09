# Remote Board over Tailscale Serve (FG-782)

This guide covers running the [Remote Board](SCHEMA-CONTRACT.md#remote-board-fg-781)
privately over a tailnet, using **Tailscale Serve** as the trusted transport in front of
Forge's loopback-only remote listener. It is written for **macOS** operation on the single
host that runs Forge.

The Remote Board itself (FG-781) ships the mode, the read-only projection, and a
fail-closed identity interface, but no transport — until you wire one, every remote request
is refused. FG-782 is the first transport: it verifies **who** a request is from through
Tailscale's own trusted channel and maps that identity to a single project's read-only view.

> **Public exposure is unsupported.** Tailscale **Funnel** (public-internet exposure) is
> explicitly **not** a supported way to run the Remote Board, and Forge refuses to proceed
> while it is enabled. See [Funnel is unsupported](#funnel-and-public-exposure-are-unsupported).

## What you get, and the boundary it keeps

An authorized tailnet user opens `https://<this-host>.<your-tailnet>.ts.net` from any device
on your tailnet and sees the read-only board for the **one** project their tailnet login is
mapped to — nothing else, and no way to change anything.

Two properties hold no matter what a request carries:

- **Forge stays bound to loopback.** The remote backend binds `127.0.0.1:8025` and the local
  dashboard binds `127.0.0.1:8024`; neither is ever widened. Tailscale Serve is a proxy *in
  front of* the loopback endpoint — it does not change what Forge binds. There is no
  `--remote-host` flag and no `FORGE_DASHBOARD_REMOTE_HOST` env var, by design.
- **Identity is proven out-of-band, never trusted from a header on its face.** Tailscale Serve
  terminates TLS on this host and proxies to `http://127.0.0.1:8025`, so at Forge's backend
  socket the connection peer is the *local Serve proxy* (loopback), not the tailnet caller —
  whois'ing that socket peer could never name the remote user. Instead the adapter:
  1. requires the backend socket peer to be **loopback** — a request that did not arrive
     through the local Serve proxy is refused;
  2. takes the Serve-set `X-Forwarded-For` as the tailnet caller's address (a *hint*) and
     confirms **that** address against the *local tailscaled* (`tailscale whois`); and
  3. requires the Serve-set `Tailscale-User-Login` to **equal** the login whois returns for
     that address.

  A header value never establishes identity by itself: the forwarded address is whois-confirmed
  and the login claim must match that confirmation. A request that does not arrive on loopback,
  carries no whois-confirmable `X-Forwarded-For`, or presents a `Tailscale-User-Login` the local
  tailscaled contradicts — including any forged-header or Funnel/public request — gets **no
  data**. Because these two Serve headers are confirmed against whois (not ignored), the
  resolution records them as *confirmed identity headers* in its audit trail.

## What remains impossible remotely

Even a login granted the `plan` capability (FG-783, [below](#granting-the-plan-capability-bounded-remote-planning--fg-783))
can do **only** the four planning actions listed there — re-rank, enqueue/dequeue, reorder the
queue, and append a planning annotation, all scoped to its own project. The remote surface is a
**closed command registry**: it dispatches only those four store actions and *cannot name* any
other verb, proven by a source-guard test, not by a runtime check. There is no arbitrary-CLI
endpoint behind it.

The following stay impossible from the Remote Board, for **any** remote identity, regardless of
capability:

- **Shipping control** — gate decisions/overrides, merge, publish, review disposition.
- **Execution** — running or dispatching agents, campaigns, or workflows; terminal/process
  control; cleanup.
- **Completion / closure** of tickets or runs.
- **Credentials, RACI/routing policy, and model-policy** changes.
- **Anything not in the four-action registry** — the surface has no generic remote CLI and no
  way to reach one; a client that fabricates an excluded action's request shape is refused.
- **Reading anything outside the project's own redacted board** — no raw logs, transcripts, env
  values, credentials, filesystem paths, review artifacts, or another project's data (the FG-781
  read boundary is unchanged).

The board also **never widens its bind**: enabling planning opens no non-loopback listener and
does not change `config.host`. Remote mutation is only ever reachable through the whois-confirmed
Tailscale identity, the operator-authored `plan` grant, and the same-origin/CSRF pin to the Serve
hostname — all three must hold.

## Prerequisite: this is a single-operator host

The Remote Board's threat model assumes the Forge host has **one** operator. Any local
process that can reach `127.0.0.1:8024`/`:8025` already has full database and filesystem
access to Forge; the loopback boundary is not a defense against other users on the same
machine. Do **not** run this on a shared/multi-user host. This is a hard prerequisite, not a
recommendation.

## Prerequisites on the host

Before you start, on the machine running Forge:

1. **Install Tailscale** and make sure the `tailscale` CLI is on your `PATH`
   (`tailscale version`).
2. **Log in to your tailnet** (`tailscale up`) so the local `tailscaled` is running and this
   node is a member.
3. **Enable MagicDNS and HTTPS certificates** for the tailnet, in the Tailscale admin console
   (**DNS** settings). Serve needs a MagicDNS name and a provisioned HTTPS cert to terminate
   TLS on `https://<host>.<tailnet>.ts.net`.
4. **Do not enable Funnel** for this node. The board is tailnet-private only.

The `forge remote tailscale doctor` command (below) checks every one of these and tells you
which are missing before you change anything.

### Tailnet ACL / grant requirements

Forge does **not** administer your Tailscale account, ACLs, or grants — you arrange tailnet
reachability yourself. What the tailnet must allow:

- **MagicDNS + HTTPS certificates** enabled for the tailnet (admin console → DNS).
- **This device permitted to run Tailscale Serve.** Tailnet members can by default; a
  restrictive ACL may need a grant for the `serve` capability on this node.
- The **tailnet users you intend to authorize** must be able to reach this node over the
  tailnet (ordinary tailnet connectivity / ACL rules).
- **Funnel not granted / not enabled** for this node.

Network reachability (ACLs/grants) is necessary but **not** sufficient: a tailnet user who
can reach the node still gets no project data until you map their login in the Forge identity
file below. Reachability is the tailnet's job; authorization is Forge's.

## Step 1 — Start the Remote Board with the Tailscale transport

The transport is selected once at boot by an explicit env var. Absent or unrecognized, no
adapter is selected and every request is refused (the FG-781 default) — this is the single
switch that turns identity verification on.

```bash
FORGE_DASHBOARD_REMOTE_TRANSPORT=tailscale \
  forge dashboard start --remote
```

- `--remote` (or `FORGE_DASHBOARD_REMOTE=1`) opts into remote mode and boots the loopback
  remote listener on `:8025`.
- `FORGE_DASHBOARD_REMOTE_TRANSPORT=tailscale` selects the Tailscale Serve adapter. The value
  is trimmed and case-insensitive; anything other than `tailscale` (including absent/empty)
  selects **no adapter**, so the board refuses every request.
- To use a non-default remote port: add `--remote-port <n>` (threads
  `FORGE_DASHBOARD_REMOTE_PORT`). It must differ from the local dashboard port (`8024`) — a
  collision is refused by name before either listener binds.

The bind stays loopback regardless of the transport; selecting an adapter never touches the
bind host.

## Step 2 — Author the identity → authorization mapping

Authorization is an operator-authored file, kept separate from the identity channel. It maps a
**whois-confirmed tailnet login** to exactly one project key and its capabilities (read-only
in this release).

Create `~/.forge/remote-board-identity.yml` (or `$FORGE_HOME/remote-board-identity.yml` if you
set `FORGE_HOME`):

```yaml
# Remote Board identity → authorization mapping (FG-782).
# Maps a whois-confirmed tailnet login to ONE project's read-only board.
version: 1
identities:
  - login: steve@example.com      # the tailnet login tailscaled reports for the peer
    project: pk-forge             # the Forge project key this login may read
    capabilities: [read]          # closed vocabulary — only `read` is valid today
  - login: teammate@example.com
    project: pk-otherproject
    capabilities: [read]
```

Field rules (all **fail closed** — every malformed case grants *less*, never more):

- `version` — must be `1` (an absent version reads as `1`). A file declaring a different
  version is rejected **whole** (nobody is granted anything).
- `login` — the tailnet login (email / OIDC subject) exactly as `tailscaled` reports it. It is
  trimmed and lower-cased on both sides, so case never causes an accidental lockout. Blank or
  non-string logins are dropped. A login declared **more than once** is *poisoned* — it gets
  **no** grant, because two lines for one identity is ambiguous intent and must never be
  silently merged into a wider grant.
- `project` — the Forge project key (e.g. `pk-…` / `repo-…`). The board's scope (which
  directories are read) is resolved **server-side** from this key against the project registry;
  the file never names directories. A grant naming an unregistered project yields no data.
- `capabilities` — a non-empty list drawn from the **closed** vocabulary. Today the only member
  is `read`. Any unknown capability (`write`, `mutate`, a typo) *taints the whole entry* and
  drops it — it is never partially granted.

An entry that fails any rule is dropped; the rest of the file still loads. A missing file, and
a login not in the file, are indistinguishable to the board: both mean **no grant**. There is
no default-allow.

You can find a project's key with `forge projects list` (or the project's `.forge/config.yml`
`project_key`).

### Granting the `plan` capability (bounded remote planning — FG-783)

By default an authorized login can only **read** its project's board. FG-783 adds one further
capability, `plan`, that grants a **bounded** set of remote *planning* mutations — and nothing
else. Add it to a login's `capabilities` list:

```yaml
version: 1
identities:
  - login: steve@example.com
    project: pk-forge
    capabilities: [read, plan]    # read the board AND run the four planning actions
  - login: teammate@example.com
    project: pk-otherproject
    capabilities: [read]          # read-only, unchanged
```

- `capabilities` is drawn from the **closed** `REMOTE_CAPABILITIES` vocabulary — today `read`
  and `plan`, nothing else. A typo (`plann`, `write`, `mutate`) *taints and drops the whole
  entry*: it fails closed to **no** grant, never silently to `read`.
- **`read` and `plan` are independent grants, not a ladder.** `[read]` is read-only (the
  default); `[read, plan]` reads *and* plans; `[plan]` alone grants planning without read. A
  `read` grant never implies `plan`. If you want someone to see the board and adjust the plan,
  grant both.
- **Granting `plan` in this file is the *only* way to enable remote mutation.** There is no
  flag, env var, or default that turns it on. Removing `plan` from a login's list (or removing
  the login) revokes it live on the next request, exactly like read revocation above.

An identity granted `plan` may run **exactly four** planning actions against its own project,
each delegating to the same authority a local operator uses and each guarded by a precondition
that refuses (with zero change) if the board moved under them:

| Action | What it does | Precondition |
|---|---|---|
| Change stack rank | Re-rank a ticket in the canonical stack | queue version compare-and-set |
| Enqueue / dequeue | Add or remove a ticket through the readiness gates | enqueue re-checks readiness; dequeue retains rank |
| Reorder the queue | Reorder the explicit operator queue | queue version compare-and-set |
| Append a planning annotation | Append a bounded operator note to a ticket | ticket revision |

Every command is idempotent and replay-resistant (a durable, per-project request-id ledger
returns the recorded outcome on redelivery — including after a Forge restart — without
re-applying, and never across projects), and every action is recorded to a same-project audit
trail (actor, transport, request id, precondition, outcome, timestamp) readable back over
`GET /api/plan/audit` — gated on the `read` capability, so a `read`-only login can see its
project's planning history even without `plan`. A stale precondition — the queue or ticket
moved since the board you are looking at loaded — refuses and hands back the current state to
re-read, rather than clobbering someone else's change.

The board's planning UI (the confirm → submit → result flow) never shows an optimistic success:
after a recorded outcome it re-reads the board so you only ever see what the host actually
committed.

## Step 3 — Inspect with `doctor` (no changes made)

`doctor` is read-only. Run it before touching anything:

```bash
forge remote tailscale doctor          # human-readable
forge remote tailscale doctor --json    # structured
```

It reports:

- **Prerequisites** — `tailscale` CLI on PATH, `tailscaled` reachable, logged in to a tailnet,
  the node's MagicDNS name, and whether the node is HTTPS-capable.
- **Proposed Serve mapping** — `https://<this-host>.<tailnet>.ts.net → http://127.0.0.1:8025`
  (tailnet-private).
- **Identity mode** — the selected transport (`FORGE_DASHBOARD_REMOTE_TRANSPORT`) and the path
  to the identity mapping file. If the transport is unset, doctor says so: the board refuses
  every request until you set it.
- **Required tailnet configuration** — the ACL/grant list you must arrange yourself.
- **Funnel status** — `off`, `ENABLED — REFUSED`, or `UNDETERMINED (treated as unsafe)`.

It exits `0` when the host is ready and `1` when setup would refuse (missing prerequisite or
Funnel enabled).

## Step 4 — Apply the Serve mapping with `setup`

```bash
forge remote tailscale setup --dry-run    # inspect only — makes NO host or tailnet change
forge remote tailscale setup              # preview the plan; still makes no change
forge remote tailscale setup --confirm    # apply the Serve mapping
```

- `--dry-run` performs **zero** host/tailnet mutations. It is enforced two ways: the plan
  carries an empty mutation set, and the command runner it is handed throws if any mutating
  `tailscale` command is even attempted — a bug cannot mutate under `--dry-run`.
- Without `--confirm`, `setup` only **previews** the exact command it would run and the mapping
  it would create; it changes nothing.
- With `--confirm`, and only after prerequisites pass and Funnel is off, `setup` runs the one
  create command
  (`tailscale serve --bg --https=443 http://127.0.0.1:8025`), then records the exact mapping
  and its inverse in `~/.forge/remote-board-serve-state.json` (owner-only `0600`).
- `setup` **never** passes a `funnel` flag and **refuses** to proceed while Funnel is enabled
  anywhere on the node.

The serve-state file is machine-authored and machine-read — you inspect it but do not
hand-edit it (unlike the identity mapping). It exists so `disable` can be surgical.

## Verify

1. `forge remote tailscale doctor` shows the active Forge Serve mapping and `Funnel: off`.
2. On another tailnet device (or the same host), open
   `https://<this-host>.<tailnet>.ts.net` — an authorized login sees its project's board.
3. Confirm the boundary holds:
   - A tailnet user **not** in the mapping file gets the `unauthorized` board (no project
     data).
   - A direct request to `http://127.0.0.1:8025` with a `Tailscale-User-Login` the local
     tailscaled does **not** confirm — a forged login, or an `X-Forwarded-For` that is not a
     whois-confirmable tailnet peer — gets **no** project data.
   - Ports `8024` and `8025` are loopback-only: `curl http://<lan-or-tailnet-ip>:8024` and
     `:8025` do not connect. Only the Serve URL reaches the board.

## Revocation (honored live, no restart)

Authorization is re-read from the mapping file on **every request** — there is no long-lived
identity cache — so revocation takes effect on the very next request:

- **Revoke one operator:** delete (or comment out) their `login` entry in
  `~/.forge/remote-board-identity.yml`. Their next request gets no data. No Forge restart.
- **Change what someone can read:** edit their `project` line; the change is live on the next
  request.
- **Revoke at the tailnet layer:** remove the node/user from the tailnet (or tighten the ACL).
  With no whois-confirmable tailnet peer, the request gets no data regardless of the mapping
  file.

Either layer is sufficient to deny; both are honored without restarting Forge.

## Disable / reset

```bash
forge remote tailscale disable          # remove ONLY the Forge-created Serve mapping
forge remote tailscale disable --json
```

`disable` removes **exactly** the one Serve handler Forge created — it replays the recorded
inverse argv (`tailscale serve --https=443 off`), never a blanket `tailscale serve reset`, so
any other Serve configuration you set up by hand is untouched. It does **not** delete Forge
data and does **not** change the local `:8024` dashboard. If there is no recorded Forge
mapping, it does nothing (rather than issuing a wrong or blanket removal).

To also stop the remote listener, stop the dashboard or restart it without
`FORGE_DASHBOARD_REMOTE_TRANSPORT` / `--remote`.

## Recovery

Loss of Tailscale or the host makes the board **unavailable** — it never falls back to a public
bind:

- If `tailscaled` is down or the node is logged out, the adapter cannot whois-confirm any peer,
  so every request gets no data (fail closed).
- If Serve is not running (or after `disable`), the tailnet URL simply does not reach the board;
  the loopback board is unaffected.
- The local `:8024` dashboard keeps working throughout — remote transport problems never
  degrade local operation.

To restore access after an outage: bring Tailscale back up (`tailscale up`), confirm with
`forge remote tailscale doctor`, and re-run `forge remote tailscale setup --confirm` if the
Serve mapping was lost.

## Funnel and public exposure are unsupported

Tailscale **Funnel** exposes a service to the public internet. The Remote Board is
**tailnet-private only** and Funnel is **not** a supported way to run it:

- `doctor` and `setup` **detect** Funnel and **refuse** to proceed while it is enabled anywhere
  on the node (they call it out explicitly). If Serve status cannot be read at all, they treat
  it as unsafe rather than assuming Funnel is off.
- `setup` never enables Funnel — it never passes a `funnel` flag.
- Even if Funnel were somehow enabled out of band, a Funnel/public request does not present a
  whois-confirmable tailnet peer, so the identity adapter refuses it and it gets no data.

If you need access from outside your tailnet, add the device to your tailnet — do not use
Funnel. If a tailnet invite isn't an option for your remote operators, see
[Remote Board over Cloudflare Tunnel + Access](how-to-remote-board-cloudflare.md) — the
public-hostname transport that fronts the same board behind a Cloudflare Access policy instead.

## Related

- [Remote Board contract (FG-781/FG-782)](SCHEMA-CONTRACT.md#remote-board-fg-781) — env vars,
  identity-mapping and serve-state file contracts, projection DTOs, loopback-only ports.
- [Remote Board over Cloudflare Tunnel + Access](how-to-remote-board-cloudflare.md) — the
  public-hostname transport that shares the same identity-mapping file and loopback boundary.
- [Remote Board section in the dashboard README](../dashboard/README.md#remote-board-fg-781).
- [Secret hygiene and redaction](redaction.md#remote-board-free-text-fg-781) — how free-text
  fields are swept before they cross the remote boundary.

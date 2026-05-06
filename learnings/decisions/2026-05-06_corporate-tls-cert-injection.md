# Decision: Inject corporate root CA into the agent image at build time

**ID**: FORGE-DEC-006
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Steven (forge build, hit during first `docker/build.sh`)
**Supersedes**: N/A
**Scope**: forge

---

## Context

Building `agent-dev-worker` from `ubuntu:22.04` failed at the `setup_20.x | bash -` step with `curl: (60) SSL certificate problem: unable to get local issuer certificate`. The host runs behind a corporate TLS-intercepting proxy (Zscaler-class). The proxy's root CA is trusted on the host (`~/root.pem`, exported via `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`), but the fresh container starts with only the public Mozilla bundle and rejects every intercepted HTTPS handshake.

The pattern doc `obsidian/stevieb-sgws/learnings/patterns/2026-03-10_containerized-multi-agent-orchestration.md` calls this out as a known gotcha: "Corporate TLS proxies (Zscaler, etc.) require injecting the root cert into the container image at build time — outbound HTTPS will fail silently without it."

---

## Problem

**How should the agent image obtain trust in the corporate CA?**

---

## Options Considered

### Option A: Disable TLS verification per-tool

`curl -k`, `npm config set strict-ssl false`, etc.

**Pros**: minimal Dockerfile change.

**Cons**: weakens every HTTPS call inside the agent. The whole reason the container is locked down is so agents can act with `--dangerously-skip-permissions` safely; turning off cert verification undermines that. Also fails for tools that don't expose a "skip TLS" flag.

---

### Option B: Mount the CA at runtime via `-v ~/root.pem:/usr/local/share/ca-certificates/...`

**Pros**: image stays generic.

**Cons**: every spawn needs to mount the cert; `update-ca-certificates` would need to run at container startup; a missed mount = silent HTTPS failure. The build itself (where curl/apt run) happens before any mount, so this doesn't help with the failing `RUN` steps.

---

### Option C: Copy the corporate CA into the image at build time and run `update-ca-certificates` ✅

`build.sh` stages `$FORGE_CA_BUNDLE` (default `~/root.pem`) into the build context as `corp-root.pem`. The Dockerfile installs `ca-certificates`, copies the bundle to `/usr/local/share/ca-certificates/corp-root.crt`, and runs `update-ca-certificates` BEFORE any HTTPS-using `RUN` step. Node + npm get an explicit `NODE_EXTRA_CA_CERTS` and `npm config set cafile` pointing at the merged bundle.

**Pros**:
- All in-image HTTPS (curl, apt, npm, Node fetch) trusts the corporate CA without per-tool hacks
- Build is self-contained and reproducible — anyone with the same `~/root.pem` builds the same image
- An empty bundle is a no-op: the `COPY` runs but `update-ca-certificates` adds zero cert. Build works on hosts that aren't behind a proxy

**Cons**:
- The image is now CA-bundle-specific. Sharing the image across environments with different proxies requires a rebuild
- A `.dockerignore` is needed to keep the build context tiny

---

## Decision

**Chose**: Option C — bake the CA into the image at build time

**Rationale**: Per-tool TLS-disable (Option A) is structurally wrong — the container boundary is the safety layer; HTTPS verification inside it should match host behavior. Runtime mount (Option B) doesn't fix the build-time failure. Build-time injection is the standard answer for this exact gotcha and is the one called out in the pattern doc. The cost is one ENV var and one COPY in the Dockerfile.

---

## Consequences

**Positive**:
- `docker/build.sh` works behind the proxy with no extra flags
- An agent's HTTPS calls (npm registry, Anthropic API, AWS endpoints) all benefit from the trusted CA without per-RUN-step adjustments
- The same Dockerfile builds cleanly off-network too: empty `corp-root.pem` is a no-op

**Negative / Trade-offs**:
- Two artifacts now live in `docker/`: the Dockerfile and a transient `corp-root.pem` staged by `build.sh`. The trap in `build.sh` deletes the cert file on exit so it doesn't linger in the working tree

**Risks**:
- If `FORGE_CA_BUNDLE` points at a stale CA (proxy CA rotated), HTTPS inside the image silently fails. Mitigation: re-run `build.sh` whenever you re-source your shell config and `~/root.pem` updates

---

## Implementation Notes

- `docker/build.sh` reads `FORGE_CA_BUNDLE` (default `~/root.pem`); copies into `docker/corp-root.pem`; cleans up via `trap`
- `docker/.dockerignore` whitelists only `agent-dev-worker.Dockerfile` and `corp-root.pem` so the build context stays minimal
- Dockerfile order: install `ca-certificates` first, COPY + `update-ca-certificates`, **then** install everything else
- `ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` and `npm config set cafile /etc/ssl/certs/ca-certificates.crt` are set explicitly because Node's TLS stack does NOT consult `/etc/ssl/certs` by default — it has its own bundled cert list

---

## Revisit Conditions

- If forge ever needs to ship a prebuilt agent image to other developers, switch to a runtime-mount approach so the image is environment-agnostic
- If the corporate proxy is replaced with a non-intercepting one — drop the COPY step; the `RUN update-ca-certificates` becomes a no-op anyway

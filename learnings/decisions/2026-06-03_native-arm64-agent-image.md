# Decision: Build the agent-dev-worker image native arm64 — drop the Rosetta tax

**ID**: FORGE-DEC-018
**Date**: 2026-06-03
**Status**: Decided — supersedes the `--platform linux/amd64` pin introduced in ticket #128
**Decided by**: Steven (perf regression noticed on Apple Silicon; closed #187)
**Scope**: forge

---

## Context

`docker/build.sh` pinned `--platform linux/amd64` so that every agent container
ran under Rosetta/qemu on Apple Silicon — a 2–4× CPU penalty on every agent
invocation. The pin had a single justification: the browser-tools `:9222` skill
required a headless Chrome binary, and `@puppeteer/browsers install chrome` only
ships `chrome-linux` (amd64). A second hidden amd64 assumption was the Go
toolchain download, which was hard-coded to `go${GOLANG_VERSION}.linux-amd64.tar.gz`.

Ticket #180 had already baked Playwright's chromium into the image for project
E2E suites (`playwright install --with-deps chromium`). Playwright's chromium
ships `linux-arm64` and speaks CDP identically to Chrome-for-Testing; it was
already present in the image, un-used by browser-tools.

---

## Decision

Drop the `--platform linux/amd64` pin from `docker/build.sh` and build native.
Two amd64 assumptions in `agent-dev-worker.Dockerfile` were updated in the same
commit:

1. **Chrome binary** — removed the `@puppeteer/browsers install chrome` step.
   After `playwright install --with-deps chromium`, the install path is located
   and symlinked to `/usr/local/bin/chromium` (the path `docker/agent-entrypoint.sh`
   launches for browser-tools). Playwright's chromium is the only binary; the two
   uses (agent `:9222` verification and project E2E suites) share it but remain
   distinct in purpose.

2. **Go tarball** — changed the download URL from the hard-coded `linux-amd64`
   suffix to `linux-$(dpkg --print-architecture)`, making it arch-aware. On the
   Apple-Silicon host this resolves to `linux-arm64`; on an amd64 host it stays
   `linux-amd64`.

Build strategy is **native-only** (no `buildx` multi-arch). The sole consumer is
a single Apple-Silicon Mac with no CI pipeline pulling the image. Cross-arch
builds for a one-off Linux target are documented in `docker/build.sh` as an
explicit `docker buildx build --platform linux/amd64` invocation.

---

## Consequences

**Positive**:
- No Rosetta/qemu overhead — agent containers run natively on arm64 hardware.
- browser-tools `:9222` works on native arm64 without any entrypoint change; the
  symlink at `/usr/local/bin/chromium` points at Playwright's arm64-capable binary.
- The `@puppeteer/browsers` Chrome-for-Testing install is gone, reducing image
  build time and size.
- Go toolchain (`go1.26.3 linux/arm64`) runs natively; `go test` and arm64 CGO
  builds no longer require emulation.

**Negative / Trade-offs**:
- The image is now host-arch specific. Building a `linux/amd64` image from this
  Mac requires an explicit `docker buildx --platform` override rather than being
  the default.

**Validated** (on rebuilt image after ad1126c):
- `docker inspect` → `Architecture: arm64`
- `uname -m` inside container → `aarch64`
- `node -p process.arch` → `arm64`
- `go env GOARCH` → `arm64`, `go version` → `go1.26.3 linux/arm64`
- Playwright chromium symlinked and serving CDP on `:9222` (Chromium 148)

**Does NOT address**: the `node_modules` host-mount mismatch between macOS and
Linux. That is an OS-vs-OS issue, not an arch issue — tracked in #245.

**Retired need**: the #271 frontend Playwright fallback (when browser-tools is
unavailable) was filed because the amd64 image made `:9222` unreliable on Apple
Silicon. Native arm64 retires the root cause, though the fallback remains as
defensive behavior.

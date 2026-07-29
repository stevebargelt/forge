FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

# Corporate TLS proxy support (Zscaler, etc.). Inject the root CA bundle BEFORE any
# HTTPS call. The build script copies $FORGE_CA_BUNDLE (default ~/root.pem) into the
# build context as `corp-root.pem`. If the file is empty, this is a no-op.
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY corp-root.pem /usr/local/share/ca-certificates/corp-root.crt
RUN update-ca-certificates

# Tooling. Done after CA trust is in place so every HTTPS call below works behind the proxy.
# sudo: the agent user gets NOPASSWD sudo (DEC-009) and the entrypoint uses it
# to chown the #245 node_modules shadow volume — but Ubuntu's base image has no
# sudo binary, so the sudoers line below was previously inert. Install it here.
# tmux (FG-551): `forge launch` owns long host-side commands under tmux (FG-535),
# and its launch tier exercises that real tmux-owned path. Without tmux in the
# image those tests hard-fail in every agent container, so a real tmux regression
# would be invisible in the noise. This does NOT let agents own task work under
# tmux — that boundary (BD-1/BD-2/BD-8) is unchanged. `tmux -V` is a build-time
# smoke: the image cannot be built without a working tmux.
RUN apt-get update && apt-get install -y \
    git wget jq openssh-client python3 python3-pip build-essential sudo tmux \
    && rm -rf /var/lib/apt/lists/* \
    && tmux -V

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
        https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Node.js 24 (LTS) + Claude Code CLI
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# Tell node + npm to trust the corporate CA at runtime as well.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN npm config set cafile /etc/ssl/certs/ca-certificates.crt \
    && npm install -g @anthropic-ai/claude-code

# Codex CLI (AWN-7 Walk): second provider runtime. Pinned for reproducible
# builds; bump CODEX_CLI_VERSION to upgrade. Provides the `codex` bin used by
# seeds/runtimes/codex-subscription.yml (`codex exec --json`).
ARG CODEX_CLI_VERSION=0.144.1
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION}

# pi coding agent (#258 Crawl / #260): third provider runtime. Provides the `pi`
# bin (bin: dist/cli.js) used by seeds/runtimes/pi-apikey.yml. Now on the current
# line (0.79.x, engines node>=22.19.0) — the image is on Node 24, so the old
# legacy-node20 (0.74.2) pin is no longer needed (FG-334). --ignore-scripts: pi
# is pure JS, no native build step — skip any postinstall (matches the #260
# install recipe).
ARG PI_CLI_VERSION=0.79.8
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_CLI_VERSION}

# Alternate package managers commonly used by projects forge runs against (#146).
# pnpm: required by Next.js / modern Node projects (e.g. harebrained-apps).
# yarn: still common in older projects. Both small; install in one layer.
# bun deliberately excluded — it's a separate JS runtime, not just a pm,
# and conflicts more than it helps. Add later if a project actually needs it.
RUN npm install -g pnpm@10 yarn

# tsx (#299): the TypeScript test/exec runner that node:test-based projects (and
# forge-test) use. Without it in the image, agents hit "Cannot find package 'tsx'"
# and improvise with ad hoc `npm i -g tsx`, reintroducing the host/container
# native-module mismatch forge-test exists to avoid. Installed GLOBALLY so the
# `tsx` CLI is on PATH for forge-test and as a fallback for a project's own
# `tsx`-based `npm test` script. (Note: a global `node --import tsx` does NOT
# resolve — global installs aren't on node's module path — so forge-test invokes
# the `tsx` CLI binary, not `node --import tsx`.) Build-time smoke: fail the image
# build if tsx is missing or broken.
ARG TSX_VERSION=4.22.4
RUN npm install -g tsx@${TSX_VERSION} && tsx --version

# System libraries for headless Chromium (browser-tools skill, #128). The
# chromium BINARY is Playwright's baked, arm64-capable build (#180 block below),
# symlinked to /usr/local/bin/chromium right after that install. #187 dropped the
# amd64-only @puppeteer/browsers Chrome-for-Testing that used to force the whole
# image to linux/amd64 — Playwright's chromium ships linux-arm64 and speaks CDP
# identically, so the entrypoint drives it on :9222 unchanged. These libs are what
# Chromium needs under --headless=new (Playwright's --with-deps also covers them;
# kept explicit as belt-and-suspenders).
RUN apt-get update && apt-get install -y \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 \
    libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Go toolchain (#168): supports Go projects including CGO cross-compilation for
# arm64 targets (e.g. Raspberry Pi). #187: the container is now native (arm64 on
# Apple Silicon), so `go test` and arm64 CGO build natively; the Go tarball is
# selected per-arch via dpkg. gcc-aarch64-linux-gnu is retained for cross-
# compiling arm64 from an amd64 host.
ENV GOLANG_VERSION=1.26.3
RUN curl -fsSL "https://go.dev/dl/go${GOLANG_VERSION}.linux-$(dpkg --print-architecture).tar.gz" \
        | tar -C /usr/local -xz \
    && apt-get update && apt-get install -y gcc-aarch64-linux-gnu && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/home/agent/go"
ENV PATH="${GOPATH}/bin:${PATH}"

# Playwright + chromium for project E2E suites (#180). Playwright's chromium
# ships linux-arm64, so since #187 this SAME binary also backs the browser-tools
# :9222 agent verification (symlinked to /usr/local/bin/chromium below) — the two
# uses stay distinct in PURPOSE (this is the project's committed E2E suite, which
# Playwright drives with its OWN browser for per-test isolation + storageState,
# the seam #176 auth plugs into; the symlink is the agent's interactive headless
# Chrome on :9222), but they share one arm64-capable binary, which is what let
# #187 drop the amd64-only Chrome-for-Testing and build native. Pinned so the
# baked browser matches the package. PLAYWRIGHT_BROWSERS_PATH is a shared,
# world-readable location (real ENV so it persists at runtime) so a project's
# `npm install` finds the pre-baked browser. --with-deps adds OS libs chromium needs.
ENV PLAYWRIGHT_VERSION=1.60.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npm install -g @playwright/test@${PLAYWRIGHT_VERSION} \
    && playwright install --with-deps chromium \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
    && CHROME_PATH=$(find "${PLAYWRIGHT_BROWSERS_PATH}" -type f -name chrome -path '*chrome-linux/chrome' | head -1) \
    && test -n "$CHROME_PATH" \
    && ln -sf "$CHROME_PATH" /usr/local/bin/chromium

# FG-608: the in-container `forge backlog` reader — SHIPPED, not merely claimed.
#
# Before this the image had NO forge CLI at all (claude-code / codex / pi / tsx and
# two shell scripts), so "forge backlog show/list resolves the mounted authority
# in-container" was true only in a test that bind-mounted the host checkout at
# /forge-src and ran tsx against it. Production creates no such mount. These two
# files are the whole surface: `forge` on PATH, and the reader it execs.
#
# NO NATIVE MODULE. The reader uses node:sqlite (Node 24 ships it), never
# better-sqlite3 — a native binding has to be built for this image's platform and is
# exactly the thing that breaks across this mount layer (FORGE-DEC-011). That also
# keeps the reader BIND-MOUNTABLE: spawn.ts binds the dispatching forge's copies of
# both files over these same paths, so a stale image cannot answer ticket questions
# with an old reader, and a fresh image works even when the bind is absent.
#
# The reader NEVER opens the host store. It resolves the authority marker on the
# read-only mount or refuses — see docker/forge-backlog-reader.mjs for why a
# fallback to $HOME/.forge would answer from the shared oauth volume.
COPY forge-backlog-reader.mjs /usr/local/lib/forge/forge-backlog-reader.mjs
COPY forge-backlog-bin.sh /usr/local/bin/forge
RUN chmod +x /usr/local/bin/forge \
    && chmod a+r /usr/local/lib/forge/forge-backlog-reader.mjs \
    && node --no-warnings -e "import('node:sqlite').then(m => { new m.DatabaseSync(':memory:').close(); console.log('node:sqlite loads'); })"

# forge-test wrapper (#111): rebuilds better-sqlite3 for this container's
# platform inside a writable scratch dir, then runs tests there. Works around
# the host/container native-module mismatch without mutating /project's
# node_modules. See docker/forge-test.sh for the rationale.
COPY forge-test.sh /usr/local/bin/forge-test
RUN chmod +x /usr/local/bin/forge-test

# Browser-tools entrypoint (#128): start headless Chromium on :9222 in the
# background, then exec the agent's command line. browser-tools scripts
# (mounted at /home/agent/.claude/skills/browser-tools) attach to :9222 via
# puppeteer-core. The script noop-skips Chrome startup when FORGE_NO_BROWSER=1
# is set or chromium is missing; this keeps tests of spawn() that don't care
# about the browser fast.
COPY agent-entrypoint.sh /usr/local/bin/agent-entrypoint
RUN chmod +x /usr/local/bin/agent-entrypoint

# Non-root agent user (DEC-009): UID 1000, NOPASSWD sudo, ~/.claude pre-created.
RUN useradd -m -s /bin/bash -u 1000 agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && mkdir -p /home/agent/.claude/skills \
    && chown -R agent:agent /home/agent

# FG-551 final smoke. The install-layer `tmux -V` at the top only proves tmux worked
# THEN — seven RUN layers follow it, and any of them can break tmux without tripping a
# thing (`mv /usr/bin/tmux /usr/bin/tmux.disabled`, `chmod -x`, a purge, an overwriting
# stub). This is the LAST RUN in the image on purpose: it re-proves, against the final
# filesystem, that a working `tmux` is on PATH. Nothing may run after it. It must stay
# failure-propagating — no `|| true`, no `; true` — a smoke that cannot fail is not a smoke.
RUN command -v tmux >/dev/null && tmux -V

USER agent
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]

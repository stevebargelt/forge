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
RUN apt-get update && apt-get install -y \
    git wget jq openssh-client python3 python3-pip build-essential sudo \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
        https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Node.js 20 + Claude Code CLI
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# Tell node + npm to trust the corporate CA at runtime as well.
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
RUN npm config set cafile /etc/ssl/certs/ca-certificates.crt \
    && npm install -g @anthropic-ai/claude-code

# Codex CLI (AWN-7 Walk): second provider runtime. Pinned for reproducible
# builds; bump CODEX_CLI_VERSION to upgrade. Provides the `codex` bin used by
# seeds/runtimes/codex-subscription.yml (`codex exec --json`).
ARG CODEX_CLI_VERSION=0.135.0
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION}

# pi coding agent (#258 Crawl / #260): third provider runtime. Provides the `pi`
# bin (bin: dist/cli.js) used by seeds/runtimes/pi-apikey.yml.
# IMPORTANT version constraint: pi's `latest` (0.78.x) declares engines node>=22,
# but this image is on Node 20. We pin the `legacy-node20` line (0.74.2, engines
# node>=20.6.0) so pi runs on this image. Bump PI_CLI_VERSION to a 0.78+ release
# only after the image moves to Node 22. --ignore-scripts: pi is pure JS, no
# native build step — skip any postinstall (matches the #260 install recipe).
ARG PI_CLI_VERSION=0.74.2
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

# headroom-ai MCP server (#316): context compression for agent containers.
# Installs the headroom_compress / headroom_retrieve MCP tools used by agent seeds.
RUN pip3 install headroom-ai[mcp]

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

USER agent
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/agent-entrypoint"]

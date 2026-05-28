FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

# Corporate TLS proxy support (Zscaler, etc.). Inject the root CA bundle BEFORE any
# HTTPS call. The build script copies $FORGE_CA_BUNDLE (default ~/root.pem) into the
# build context as `corp-root.pem`. If the file is empty, this is a no-op.
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY corp-root.pem /usr/local/share/ca-certificates/corp-root.crt
RUN update-ca-certificates

# Tooling. Done after CA trust is in place so every HTTPS call below works behind the proxy.
RUN apt-get update && apt-get install -y \
    git wget jq openssh-client python3 python3-pip build-essential \
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

# Alternate package managers commonly used by projects forge runs against (#146).
# pnpm: required by Next.js / modern Node projects (e.g. harebrained-apps).
# yarn: still common in older projects. Both small; install in one layer.
# bun deliberately excluded — it's a separate JS runtime, not just a pm,
# and conflicts more than it helps. Add later if a project actually needs it.
RUN npm install -g pnpm@10 yarn

# Headless Chrome for the browser-tools skill (#128): Ubuntu 22.04's
# chromium-browser apt package is a snap-stub that doesn't work in containers,
# and google-chrome-stable is amd64-only (we build arm64 on Apple Silicon and
# need multi-arch long-term). Chromium-for-Testing ships both arm64 and amd64
# builds; install via @puppeteer/browsers (the canonical headless-Chrome
# installer puppeteer-core itself uses). System libs first so Chromium has
# what it needs to start under --headless=new.
RUN apt-get update && apt-get install -y \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libnspr4 \
    libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_CACHE_DIR=/opt/puppeteer-cache
RUN npx --yes @puppeteer/browsers install chrome@stable --path "$PUPPETEER_CACHE_DIR" \
    && CHROME_PATH=$(find "$PUPPETEER_CACHE_DIR" -type f -name chrome -executable | head -1) \
    && test -n "$CHROME_PATH" \
    && ln -sf "$CHROME_PATH" /usr/local/bin/chromium

# Go toolchain (#168): supports Go projects including CGO cross-compilation
# for arm64 targets (e.g. Raspberry Pi). The container is amd64 (pinned for
# Chrome), so `go test` runs natively; cross-compile via GOARCH=arm64 for
# deploy artifacts. gcc-aarch64-linux-gnu provides the CGO cross-compiler.
ENV GOLANG_VERSION=1.26.3
RUN curl -fsSL "https://go.dev/dl/go${GOLANG_VERSION}.linux-amd64.tar.gz" \
        | tar -C /usr/local -xz \
    && apt-get update && apt-get install -y gcc-aarch64-linux-gnu && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/local/go/bin:${PATH}"
ENV GOPATH="/home/agent/go"
ENV PATH="${GOPATH}/bin:${PATH}"

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

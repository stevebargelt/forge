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

# Playwright Chromium. Agents that need firefox/webkit can install on demand.
RUN npm install -g playwright \
    && npx --yes playwright install --with-deps chromium

# forge-test wrapper (#111): rebuilds better-sqlite3 for this container's
# platform inside a writable scratch dir, then runs tests there. Works around
# the host/container native-module mismatch without mutating /project's
# node_modules. See docker/forge-test.sh for the rationale.
COPY forge-test.sh /usr/local/bin/forge-test
RUN chmod +x /usr/local/bin/forge-test

# Non-root agent user (DEC-009): UID 1000, NOPASSWD sudo, ~/.claude pre-created.
RUN useradd -m -s /bin/bash -u 1000 agent \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && mkdir -p /home/agent/.claude \
    && chown -R agent:agent /home/agent

USER agent
WORKDIR /workspace

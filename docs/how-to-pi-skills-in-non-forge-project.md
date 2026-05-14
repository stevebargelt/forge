# Using pi-skills in a non-forge project

Short note for adding Mario Zechner's [pi-skills](https://github.com/badlogic/pi-skills) (browser-tools, gccli, gdcli, etc.) to a project that doesn't run through forge. Assumes pi-skills is already cloned at `~/pi-skills` and the host-side symlink is wired (`~/.claude/skills/<skill> → ~/pi-skills/<skill>`).

## One-time host setup (skip if already done)

```bash
# Clone the repo
git clone https://github.com/badlogic/pi-skills ~/pi-skills

# Symlink each skill you want into ~/.claude/skills
mkdir -p ~/.claude/skills
ln -s ~/pi-skills/browser-tools ~/.claude/skills/browser-tools
# Repeat per skill: gccli, gdcli, gmcli, transcribe, etc.

# Install the skill's deps
cd ~/pi-skills/browser-tools && npm install
```

Verify in a fresh `claude --print` session — the init message should list `skills: [..., "browser-tools", ...]`.

## Adding pi-skills to a new project

Nothing per-project for pure host use. Once the symlinks above are in place, Claude Code sessions in any directory can invoke skills via `/browser-tools` or similar.

## If the project runs agents in containers

Containerized agents don't see `~/.claude/skills/*` automatically — those symlinks are on the host. Two options:

**(A) Mount the skills directory read-only.** Add to the container spawn:

```
-v ~/pi-skills/browser-tools:/home/agent/.claude/skills/browser-tools:ro
```

Per skill, or mount the whole `~/.claude/skills` directory if multiple are needed. The container's `claude` CLI picks them up from `~/.claude/skills/` exactly like the host does.

**(B) Bake selected skills into the container image.** Copy the skill directory in the Dockerfile and `npm install` inside the image. Higher cost (rebuild on skill updates) but no host dependency at run time.

forge takes approach (A) — see `seeds/runtimes/claude-*.yml`'s mount block.

## Browser-tools specifics

`browser-tools` needs a Chromium running on port 9222 with remote debugging. On the host, `~/pi-skills/browser-tools/start-chrome.sh` handles that. In containers, you need either:
- A host Chromium reachable via `host.docker.internal:9222` (the simpler path)
- Chromium baked into the image (forge does this in `docker/agent-dev-worker/Dockerfile`)

For a non-forge project running purely on the host, the host Chrome is fine — start it with the script before the agent session, and the symlink wiring takes care of the rest.

## Verifying the install

```bash
claude --print "Use browser-tools to open https://example.com and report the title"
```

If browser-tools is wired correctly, the agent will spin up the skill, open Chrome (or attach to an existing instance), navigate, and report. If not, the agent will say "I don't have a browser-tools skill available" or similar — the symlink is missing or the skill's deps aren't installed.

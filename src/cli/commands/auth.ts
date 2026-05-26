import type { Command } from "commander";
import { spawn as cpSpawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  detectStaleStsCache,
  getAuthState,
  legacyOauthVolumeName,
  oauthVolumeName,
  probeAwsChain,
  writeOauthHint,
} from "../../util/creds.js";
import { ssoWatchdogLogFile } from "../../util/sso-watchdog.js";

// `forge auth` manages the Anthropic OAuth credential volume used by agent containers.
// On macOS the host's Claude Code stores OAuth in the keychain — agents can't read that —
// so each forge install owns its own credential, persisted in a named docker volume.

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Manage Anthropic OAuth credentials for agent containers");

  auth
    .command("login")
    .option("--image <name>", "agent image to use", "agent-dev-worker")
    .description("Run `claude` interactively inside a container so its OAuth credential lands in the forge volume")
    .action(async (opts) => {
      const volume = oauthVolumeName();
      console.log(`Logging in. Credential will persist in docker volume '${volume}'.`);
      console.log("When the prompt appears inside claude, run /login and follow the browser flow.");
      console.log("Type /exit when finished.\n");
      // Volume mounts at /home/agent (the user's home inside the container)
      // so claude's $HOME-level .claude.json AND the $HOME/.claude/ subtree
      // both land in the volume. Earlier versions mounted only the .claude/
      // subdir, which lost .claude.json (identity info) to the container's
      // ephemeral writable layer.
      const code = await runInteractive("docker", [
        "run",
        "--rm",
        "-it",
        "-v",
        `${volume}:/home/agent`,
        opts.image,
        "claude",
      ]);
      if (code !== 0) {
        throw new Error(`claude exited ${code}. Volume may not contain credentials. Re-run \`forge auth login\` to retry.`);
      }
      // Verify the credential file landed AND capture identity hint
      // (#97 follow-up). One docker run reads both files in a single sh
      // invocation; output is `<yes|no>\n<.claude.json content or empty>`.
      // Same format probeOauthVolume() uses elsewhere — keep them in sync
      // if you change it.
      let raw = "";
      try {
        raw = execFileSync("docker", [
          "run",
          "--rm",
          "-v",
          `${volume}:/home/agent:ro`,
          "alpine",
          "sh",
          "-c",
          '[ -s /home/agent/.claude/.credentials.json ] && echo yes || echo no; [ -f /home/agent/.claude.json ] && cat /home/agent/.claude.json || echo ""',
        ], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      } catch {
        console.log(`\n⚠ Could not verify volume '${volume}' (docker run failed).`);
        return;
      }
      const newlineIdx = raw.indexOf("\n");
      const credsPresent = newlineIdx >= 0 && raw.slice(0, newlineIdx).trim() === "yes";
      if (!credsPresent) {
        console.log(`\n⚠ No /home/agent/.claude/.credentials.json found in volume '${volume}'.`);
        console.log("  Did you run /login successfully? Try again with `forge auth login`.");
        // Still write a hint so the dashboard knows we tried.
        try { writeOauthHint({ credsPresent: false }); } catch { /* best-effort */ }
        return;
      }
      // Parse identity from .claude.json's oauthAccount block. Same field
      // mapping as probeOauthVolume() — keep aligned.
      let identity: { email?: string; organizationName?: string; plan?: string; loggedInAt?: string } = {};
      const claudeJsonRaw = newlineIdx >= 0 ? raw.slice(newlineIdx + 1).trim() : "";
      if (claudeJsonRaw) {
        try {
          const parsed = JSON.parse(claudeJsonRaw) as { oauthAccount?: Record<string, unknown> };
          const oa = parsed.oauthAccount;
          if (oa && typeof oa === "object") {
            const str = (k: string) => (typeof oa[k] === "string" && oa[k] ? (oa[k] as string) : undefined);
            identity = {
              email: str("emailAddress"),
              organizationName: str("organizationName"),
              plan: str("organizationType"),
              loggedInAt: str("subscriptionCreatedAt"),
            };
          }
        } catch {
          /* malformed; identity stays empty, credsPresent still true */
        }
      }
      try {
        writeOauthHint({ credsPresent: true, ...identity });
      } catch {
        /* hint write is best-effort */
      }
      console.log(`\n✓ Credentials saved to volume '${volume}'.`);
      if (identity.email) console.log(`  Account: ${identity.email}`);
      if (identity.organizationName) console.log(`  Org:     ${identity.organizationName}`);
      if (identity.plan) console.log(`  Plan:    ${identity.plan}`);
    });

  auth
    .command("status")
    .description("Report which credentials forge agents will use")
    .option("--deep", "actively probe credentials (runs `aws sts get-caller-identity` for bedrock)")
    .action((opts: { deep?: boolean }) => {
      // #120a: surface the full getAuthState() snapshot (the dashboard's been
      // using it via #97 for a while; the CLI was still printing the dumb
      // two-liner from before getAuthState existed).
      const state = getAuthState();
      console.log(`Auth mode:    ${state.mode}`);
      console.log(`Health:       ${state.health}`);
      if (state.identity)    console.log(`Identity:     ${state.identity}`);
      if (state.remediation) console.log(`Remediation:  ${state.remediation}`);

      if (state.mode === "bedrock") {
        const d = state.detail;
        if (d.profile)     console.log(`Profile:      ${d.profile}`);
        if (d.accountId)   console.log(`Account:      ${d.accountId}`);
        if (d.roleName)    console.log(`Role:         ${d.roleName}`);
        if (d.region)      console.log(`Region:       ${d.region}`);
        if (d.ssoPortal)   console.log(`SSO portal:   ${d.ssoPortal}`);
        if (d.expiresAt)   console.log(`SSO expires:  ${d.expiresAt}`);
        console.log(`Watchdog:     ${d.watchdogRunning ? "running" : "not running"}`);

        // #119: surface STS-cache staleness even when SSO + STS are both
        // clock-valid. Catches the "manual `aws sso login` revoked the old
        // STS chain" case before the user spawns a doomed agent.
        const staleness = detectStaleStsCache();
        if (staleness?.stale) {
          console.log(`\n⚠ ${staleness.reason}`);
        }

        if (opts.deep && d.profile) {
          // #120b: actually exercise the chain. ~500ms but the only honest
          // way to know auth works. CLI-only — too expensive for the
          // dashboard's poll path.
          process.stdout.write(`Deep probe:   running aws sts get-caller-identity ...`);
          const probe = probeAwsChain(d.profile);
          if (probe.ok) {
            console.log(` ✓ chain works`);
            if (probe.account) console.log(`  Account:    ${probe.account}`);
            if (probe.arn)     console.log(`  Caller:     ${probe.arn}`);
          } else {
            console.log(` ✗ ${probe.error}`);
          }
        }
      } else if (state.mode === "anthropic-oauth") {
        const d = state.detail;
        if (d.oauthVolume)        console.log(`OAuth volume: ${d.oauthVolume}`);
        if (d.oauthEmail)         console.log(`Account:      ${d.oauthEmail}`);
        if (d.oauthOrganization)  console.log(`Org:          ${d.oauthOrganization}`);
        if (d.oauthPlan)          console.log(`Plan:         ${d.oauthPlan}`);
        // Warn about orphaned v1 volume from before the /home/agent mount
        // migration. Harmless but taking up space; user may want to remove.
        const volume = oauthVolumeName();
        const legacy = legacyOauthVolumeName();
        if (legacy !== volume) {
          try {
            execFileSync("docker", ["volume", "inspect", legacy], { stdio: "ignore" });
            console.log(`\n⚠ Legacy volume '${legacy}' is still present (from before the mount-point migration).`);
            console.log(`  Safe to remove: docker volume rm ${legacy}`);
          } catch {
            /* legacy volume doesn't exist — nothing to warn about */
          }
        }
      }
    });

  // #118: the SSO watchdog now logs to ~/.forge/sso-watchdog.log instead of
  // /dev/null. This subcommand prints the path + tails the last N lines so
  // failures are visible without remembering where the log lives.
  auth
    .command("watchdog-tail")
    .description("Print the SSO watchdog log path and tail recent lines")
    .option("-n, --lines <n>", "lines to tail (default: 50)", "50")
    .action((opts: { lines?: string }) => {
      const logPath = ssoWatchdogLogFile();
      console.log(`Log: ${logPath}`);
      if (!existsSync(logPath)) {
        console.log("(no log yet — the watchdog hasn't run since #118 shipped, or it's disabled)");
        return;
      }
      const n = Math.max(1, Number(opts.lines ?? "50") || 50);
      const lines = readFileSync(logPath, "utf8").split("\n");
      // .split leaves an empty trailing element if the file ends with \n;
      // drop it so the tail count matches user expectation.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const tail = lines.slice(Math.max(0, lines.length - n));
      console.log(`---- last ${tail.length} line(s) ----`);
      for (const l of tail) console.log(l);
    });

  auth
    .command("logout")
    .description("Delete the OAuth credential volume")
    .action(() => {
      const volume = oauthVolumeName();
      try {
        execFileSync("docker", ["volume", "rm", volume], { stdio: "inherit" });
        console.log(`Removed volume ${volume}.`);
      } catch {
        console.log(`Volume ${volume} did not exist or could not be removed.`);
      }
      // Clear the host-side identity hint so the dashboard doesn't keep
      // showing a stale email after logout.
      try {
        const forgeHome = process.env.FORGE_HOME ?? join(homedir(), ".forge");
        const hint = join(forgeHome, "oauth-hint.json");
        if (existsSync(hint)) unlinkSync(hint);
      } catch {
        /* best-effort */
      }
    });
}

function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = cpSpawn(cmd, args, { stdio: "inherit" });
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}

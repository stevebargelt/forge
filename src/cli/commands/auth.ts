import type { Command } from "commander";
import { spawn as cpSpawn, execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { oauthVolumeName, legacyOauthVolumeName, writeOauthHint } from "../../util/creds.js";

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
    .action(() => {
      const volume = oauthVolumeName();
      const mode = process.env.CLAUDE_CODE_USE_BEDROCK === "1"
        ? "bedrock"
        : process.env.ANTHROPIC_API_KEY ? "anthropic-apikey" : "anthropic-oauth";
      console.log(`Auth mode: ${mode}`);
      if (mode === "anthropic-oauth") {
        console.log(`OAuth volume: ${volume}`);
        // Warn about orphaned v1 volume from before the /home/agent mount
        // migration. Harmless but taking up space; user may want to remove.
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
      if (mode === "bedrock") console.log(`AWS_REGION:   ${process.env.AWS_REGION ?? "(unset)"}`);
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

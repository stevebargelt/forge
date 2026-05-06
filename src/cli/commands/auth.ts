import type { Command } from "commander";
import { spawn as cpSpawn, execFileSync } from "node:child_process";
import { oauthVolumeName } from "../../util/creds.js";

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
      const code = await runInteractive("docker", [
        "run",
        "--rm",
        "-it",
        "-v",
        `${volume}:/home/agent/.claude`,
        opts.image,
        "claude",
      ]);
      if (code !== 0) {
        throw new Error(`claude exited ${code}. Volume may not contain credentials. Re-run \`forge auth login\` to retry.`);
      }
      // Verify the credential file landed.
      try {
        execFileSync("docker", [
          "run",
          "--rm",
          "-v",
          `${volume}:/home/agent/.claude`,
          opts.image,
          "test",
          "-s",
          "/home/agent/.claude/.credentials.json",
        ], { stdio: "ignore" });
        console.log(`\n✓ Credentials saved to volume '${volume}'.`);
      } catch {
        console.log(`\n⚠ No /home/agent/.claude/.credentials.json found in volume '${volume}'.`);
        console.log("  Did you run /login successfully? Try again with `forge auth login`.");
      }
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
      if (mode === "anthropic-oauth") console.log(`OAuth volume: ${volume}`);
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
    });
}

function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = cpSpawn(cmd, args, { stdio: "inherit" });
    proc.on("exit", (code) => resolve(code ?? 1));
  });
}

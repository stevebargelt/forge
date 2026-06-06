// #266: `forge pi login` — mint pi's OAuth credential (your Claude Pro/Max
// subscription, or ChatGPT/Copilot) so the pi-oauth runtime can run on it without
// an API key. pi is NOT installed on the host, so this runs pi's interactive
// `/login` inside a container with ~/.forge/pi-agent bind-mounted, persisting the
// resulting auth.json to the host. Mirrors `forge auth login` (claude OAuth) and
// `codex login`.

import type { Command } from "commander";
import { spawn as cpSpawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { piAgentDir, piAuthFile } from "../../util/creds.js";

function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = cpSpawn(cmd, args, { stdio: "inherit" });
    proc.on("exit", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
  });
}

export function registerPi(program: Command): void {
  const pi = program.command("pi").description("pi runtime auth (#266).");

  pi
    .command("login")
    .option("--image <name>", "agent image to use", "agent-dev-worker")
    .description("Run pi interactively in a container so its OAuth credential lands in ~/.forge/pi-agent/auth.json")
    .action(async (opts: { image: string }) => {
      const dir = piAgentDir();
      mkdirSync(dir, { recursive: true });
      console.log(`Logging pi in. Credential will persist at ${piAuthFile()}.`);
      console.log("When pi's prompt appears, type:  /login   (bare), then SELECT a provider from the menu —");
      console.log("  e.g. 'Claude Pro/Max' for a subscription (OAuth), or an API-key provider.");
      console.log("Open the OAuth URL it prints, authorize, then:");
      console.log("  → the browser WILL fail to load the localhost callback — that is EXPECTED (pi's callback");
      console.log("    server is inside this container). Copy the FULL failed URL from the address bar and");
      console.log("    paste it into pi's 'Paste the authorization code or full redirect URL' prompt.");
      console.log("Type /exit when done.");
      console.log("NOTE: subscription usage via a third-party harness is billed per-token as 'extra usage',");
      console.log("      NOT against your flat plan limits.\n");

      // Bind-mount the host agent dir at the container's PI_CODING_AGENT_DIR so
      // pi writes auth.json straight to the host. --entrypoint pi runs the TUI
      // directly (skips the Chromium-starting agent-entrypoint).
      const code = await runInteractive("docker", [
        "run", "--rm", "-it",
        "-e", "PI_CODING_AGENT_DIR=/pi-agent",
        "-e", "FORGE_NO_BROWSER=1",
        "-v", `${dir}:/pi-agent`,
        "--entrypoint", "pi",
        opts.image,
      ]);

      if (!existsSync(piAuthFile())) {
        console.log(`\n⚠ No credential at ${piAuthFile()} (pi exited ${code}).`);
        console.log("  Did `/login` (then provider select) complete? Re-run `forge pi login` to retry.");
        return;
      }
      console.log(`\n✓ pi OAuth credential saved at ${piAuthFile()}.`);
      console.log("  Use it with:  forge invoke --runtime pi-oauth --route <key> --task \"…\"");
    });
}

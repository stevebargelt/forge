import type { Command } from "commander";
import { captureViaBrowser } from "../../util/cdp-capture.js";
import {
  listProfileNames,
  profileStatus,
  removeProfile,
  writeProfile,
  fmtExpiry,
  type ProfileStatus,
} from "../../util/auth-profiles.js";

// `forge auth-profile` manages captured app-under-test browser sessions (#176).
// This is ORTHOGONAL to `forge auth` (which manages the Anthropic API credential
// for agent containers). Naming is deliberately distinct.

function printStatus(s: ProfileStatus): void {
  if (!s.exists) {
    console.log(`Profile '${s.name}': not found (${s.path})`);
    return;
  }
  console.log(`Profile '${s.name}'`);
  console.log(`  Path:    ${s.path}`);
  console.log(`  Domains: ${s.domains.join(", ") || "(none)"}`);
  console.log(`  Session: ${fmtExpiry(s)}`);
}

export function registerAuthProfile(program: Command): void {
  const ap = program
    .command("auth-profile")
    .description("Manage captured app-under-test browser sessions for authenticated testing (#176)");

  ap
    .command("login <name>")
    .requiredOption("--url <url>", "URL to open for the login flow")
    .description("Launch a browser, let you log in, and capture the session as a named profile")
    .action(async (name: string, opts: { url: string }) => {
      const { state, capturedOrigin } = await captureViaBrowser(opts.url);
      const lsCount = state.origins.reduce((n, o) => n + o.localStorage.length, 0);
      const path = writeProfile(name, state);
      console.log(`\n✓ Captured session from ${capturedOrigin}`);
      console.log(`  ${state.cookies.length} cookie(s), ${lsCount} localStorage entr(ies)`);
      console.log(`  Saved to ${path} (mode 600)`);
      const s = profileStatus(name);
      console.log(`  Session: ${fmtExpiry(s)}`);
      if (s.expired) {
        console.log(`\n⚠ The captured session is already expired. Did the login complete before you pressed Enter?`);
      } else if (s.expiresAt === null) {
        console.log(`\n⚠ Could not determine expiry — fail-fast on expiry won't work for this profile.`);
      }
    });

  ap
    .command("status [name]")
    .description("Show a profile's domains + session validity (all profiles if no name)")
    .action((name?: string) => {
      if (name) {
        printStatus(profileStatus(name));
        return;
      }
      const names = listProfileNames();
      if (names.length === 0) {
        console.log("No auth profiles. Create one with: forge auth-profile login <name> --url <url>");
        return;
      }
      for (const n of names) {
        printStatus(profileStatus(n));
        console.log("");
      }
    });

  ap
    .command("list")
    .description("List profile names with a one-line validity summary")
    .action(() => {
      const names = listProfileNames();
      if (names.length === 0) {
        console.log("No auth profiles.");
        return;
      }
      for (const n of names) {
        const s = profileStatus(n);
        console.log(`${n}\t${s.domains.join(",") || "(no domains)"}\t${fmtExpiry(s)}`);
      }
    });

  ap
    .command("rm <name>")
    .description("Delete a profile's captured session")
    .action((name: string) => {
      const removed = removeProfile(name);
      console.log(removed ? `Removed profile '${name}'.` : `Profile '${name}' did not exist.`);
    });
}

import { existsSync } from "node:fs";

// FG-642: ONE Chrome/Chromium resolution path for the whole repo — the dashboard
// browser tier (dashboard/browser-tests/*) and the host-side CDP capture. Six
// hand-copied candidate lists is the mechanism by which the browser tier went
// dark: only the newest copy listed the agent image's chromium, so in every agent
// container four of five suites resolved nothing and skipped to green.
//
// Lives in src/util/ deliberately: release.ts excludes browser-tests/ from the
// release closure but ships src/, so this is the one place both consumers can
// import from without dragging test code into a release.

export const KNOWN_CHROME_LOCATIONS: readonly string[] = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  // The agent-dev-worker image symlinks Playwright's arm64-capable chromium here
  // (docker/agent-dev-worker.Dockerfile). Without this entry the browser tier is
  // dark in exactly the container the verify phase runs in.
  "/usr/local/bin/chromium",
];

export interface ChromeResolveOptions {
  env?: { FORGE_CHROME_BIN?: string | undefined; CHROME_PATH?: string | undefined };
  /** Replaces the built-in locations. The fail-first pin masks the real ones with this. */
  locations?: readonly string[];
}

function override(opts: ChromeResolveOptions): string | undefined {
  const raw = (opts.env ?? process.env).FORGE_CHROME_BIN;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function probeOrder(opts: ChromeResolveOptions): string[] {
  const hinted = (opts.env ?? process.env).CHROME_PATH?.trim();
  const locations = opts.locations ?? KNOWN_CHROME_LOCATIONS;
  return hinted ? [hinted, ...locations] : [...locations];
}

/**
 * The resolved binary, or undefined. `FORGE_CHROME_BIN` overrides everything: when
 * it is set it is the ONLY thing consulted, so an operator who points it somewhere
 * wrong hears about that path rather than silently getting a different browser.
 * `CHROME_PATH` stays a lenient first candidate (its long-standing meaning here).
 */
export function findChrome(opts: ChromeResolveOptions = {}): string | undefined {
  const forced = override(opts);
  if (forced) return existsSync(forced) ? forced : undefined;
  return probeOrder(opts).find(existsSync);
}

/**
 * The named precondition failure. Modeled on the FG-551 tmux tier: an environment
 * that cannot run the work must FAIL with a message that says what is missing and
 * how to supply it — never skip to green.
 */
export function chromePreconditionMessage(purpose: string, opts: ChromeResolveOptions = {}): string {
  const forced = override(opts);
  const where = forced
    ? `FORGE_CHROME_BIN is set to ${forced} and no file exists there`
    : `probed: ${probeOrder(opts).join(", ")}`;
  return (
    `chrome precondition: ${purpose} requires a real Chrome/Chromium binary and none was found — ${where}. ` +
    `Set FORGE_CHROME_BIN to its path (agent containers ship /usr/local/bin/chromium; ` +
    `macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome; ubuntu: npx playwright-core install --with-deps chromium). ` +
    `A Chrome-less environment must FAIL this tier, never skip to green (FG-642).`
  );
}

export function requireChrome(purpose: string, opts: ChromeResolveOptions = {}): string {
  const found = findChrome(opts);
  if (!found) throw new Error(chromePreconditionMessage(purpose, opts));
  return found;
}

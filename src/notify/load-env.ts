// Loads ~/.forge/notify.env (KEY=value per line) into process.env.
//
// Why: keeps notification creds in forge's config dir alongside the rest of
// host-global state (~/.forge/forge.db, agents/, constraints/), out of the
// repo, and not polluting every shell. The file is a fallback — shell-set env
// vars win, so users with TWILIO_* already exported (e.g. shared with another
// Twilio-using tool) keep working unchanged.
//
// Format: bash-flavored KEY=value. Blank lines and `# comments` ignored.
// Surrounding "..." or '...' around the value is stripped (matches what users
// will paste when copying from Twilio's console).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FORGE_HOME } from "../util/paths.js";

export const NOTIFY_ENV_PATH = join(FORGE_HOME, "notify.env");

export function loadNotifyEnv(path: string = NOTIFY_ENV_PATH): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key.length === 0) continue;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquote(trimmed.slice(eq + 1).trim());
  }
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

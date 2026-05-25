// State machine + storage for Twilio SMS subscription consent (#145).
//
// Three files in ~/.forge/:
// - notify.env: the live TWILIO_* env file (existing). We surgically update
//   the TWILIO_TO line on subscribe/unsubscribe; other lines are preserved.
// - notify-state.json: mutable. Current confirmed subscription + any pending
//   confirmation. Single JSON object. Atomic writes (write-temp + rename).
// - notify-consent.log: append-only JSON-lines audit. Twilio support may ask
//   for this; never truncate or rewrite a prior line.

import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from "node:fs";
import { randomInt } from "node:crypto";
import { dirname, join } from "node:path";
import { FORGE_HOME } from "../util/paths.js";

export type Subscription = {
  to: string;
  subscribedAt: string;
};

export type PendingConfirmation = {
  to: string;
  code: string;
  createdAt: string;
  expiresAt: string;
};

export type NotifyState = {
  currentSubscription: Subscription | null;
  pendingConfirmation: PendingConfirmation | null;
};

export type ConsentEvent = {
  event: "subscribe-requested" | "subscribe-confirmed" | "subscribe-cancelled" | "unsubscribe";
  to: string;
  at: string;
  method?: string;
  note?: string;
};

const STATE_PATH = join(FORGE_HOME, "notify-state.json");
const CONSENT_LOG_PATH = join(FORGE_HOME, "notify-consent.log");
const NOTIFY_ENV_PATH = join(FORGE_HOME, "notify.env");

export const PATHS = {
  state: STATE_PATH,
  log: CONSENT_LOG_PATH,
  env: NOTIFY_ENV_PATH,
};

const DEFAULT_STATE: NotifyState = { currentSubscription: null, pendingConfirmation: null };

export function loadState(path: string = STATE_PATH): NotifyState {
  if (!existsSync(path)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<NotifyState>;
    return {
      currentSubscription: parsed.currentSubscription ?? null,
      pendingConfirmation: parsed.pendingConfirmation ?? null,
    };
  } catch {
    // Corrupt file: treat as empty state rather than crashing the CLI.
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: NotifyState, path: string = STATE_PATH): void {
  // Atomic: write to .tmp, then rename. Prevents partial writes from
  // corrupting state if the process dies mid-write.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function appendConsentLog(event: ConsentEvent, path: string = CONSENT_LOG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
}

// 4-digit confirmation code, no leading zero. Pure-random; not derived from
// the number or any secret — just a one-time challenge.
export function generateConfirmationCode(): string {
  // Range 1000-9999 inclusive gives 4-digit no-leading-zero.
  return String(randomInt(1000, 10000));
}

// Surgically writes TWILIO_TO into ~/.forge/notify.env. Preserves all other
// lines (other env vars, comments, blanks). If `number` is null, removes the
// TWILIO_TO line entirely. Creates the file if missing.
export function updateNotifyEnvTo(number: string | null, path: string = NOTIFY_ENV_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];

  // Find the existing TWILIO_TO line (first match wins; ignore commented-out variants).
  const idx = lines.findIndex((l) => /^\s*TWILIO_TO\s*=/.test(l));

  if (number === null) {
    if (idx === -1) return;  // already absent, no-op
    lines.splice(idx, 1);
  } else {
    const newLine = `TWILIO_TO=${number}`;
    if (idx === -1) {
      // Append. If the file is non-empty and doesn't end with a newline-terminated
      // last line, ensure separation.
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push(newLine);
      else lines.splice(Math.max(lines.length - 1, 0), 0, newLine);
    } else {
      lines[idx] = newLine;
    }
  }

  // Ensure trailing newline (matches POSIX text-file convention).
  let out = lines.join("\n");
  if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  // Atomic write.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, out, "utf8");
  renameSync(tmp, path);
}

// E.164 sanity check. Twilio accepts the request anyway for malformed numbers,
// so this is purely a UX guardrail — we'd rather fail at `subscribe` than send
// a malformed SMS that gets a bewildering Twilio error code back.
export function looksLikeE164(s: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(s);
}

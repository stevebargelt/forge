// ntfy push notification transport. Parallel to twilio.ts — same contract:
// never throws, errors returned as { ok: false, error }.

export type NtfyResult =
  | { ok: true }
  | { ok: false; error: string };

const REQUIRED_VARS = ["NTFY_URL"] as const;

export function isNtfyEnabled(): boolean {
  const providers = (process.env["FORGE_NOTIFY"] ?? "").split(",").map(s => s.trim());
  if (!providers.includes("ntfy")) return false;
  for (const k of REQUIRED_VARS) {
    const v = process.env[k];
    if (!v || v.length === 0) return false;
  }
  return true;
}

// FG-494: fetch header values are ByteStrings (Latin-1), so a value
// containing a character outside 0x00-0x7F either throws at request
// construction (>0xFF, e.g. an em-dash) or silently mojibakes (0x80-0xFF,
// e.g. 'é' as raw byte 0xE9 isn't valid UTF-8 on its own). ntfy documents
// RFC 2047 encoded-words (`=?UTF-8?B?<base64>?=`) as its supported mechanism
// for non-Latin-1 header text, so encode whenever any non-ASCII character is
// present — that one >0x7F check covers both failure modes. Pure-ASCII values
// pass through byte-identical (no wrapper applied). Named generically (not
// `encodeNtfyTitle`) because it applies to ANY ntfy header carrying free-form
// or user-supplied text (e.g. Title today; Tags/Actions if a future caller
// drives them from user text) — route such headers through this, not just Title.
function encodeNtfyHeaderValue(value: string): string {
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const base64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${base64}?=`;
}

export async function notifyNtfy(body: string, title?: string): Promise<NtfyResult> {
  if (!isNtfyEnabled()) {
    return { ok: false, error: "FORGE_NOTIFY does not include 'ntfy' or NTFY_URL is missing" };
  }
  const url = process.env["NTFY_URL"]!;
  const token = process.env["NTFY_TOKEN"];

  const headers: Record<string, string> = {};
  if (title) headers["Title"] = encodeNtfyHeaderValue(title);
  headers["Priority"] = process.env["NTFY_PRIORITY"] ?? "default";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
}

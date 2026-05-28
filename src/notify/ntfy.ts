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

export async function notifyNtfy(body: string, title?: string): Promise<NtfyResult> {
  if (!isNtfyEnabled()) {
    return { ok: false, error: "FORGE_NOTIFY does not include 'ntfy' or NTFY_URL is missing" };
  }
  const url = process.env["NTFY_URL"]!;
  const token = process.env["NTFY_TOKEN"];

  const headers: Record<string, string> = {};
  if (title) headers["Title"] = title;
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

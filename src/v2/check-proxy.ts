// Health check for headroom proxy
import { PROXY_BASE_URL } from "./compression-modes.js";

export async function checkProxyHealth(): Promise<{ healthy: boolean; error?: string; version?: string }> {
  try {
    const response = await fetch(`${PROXY_BASE_URL}/healthz`, {
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      return { healthy: false, error: `Proxy returned ${response.status}` };
    }

    const data = (await response.json()) as { ok?: boolean; status?: string; version?: string; service?: string };
    const healthy = data.ok === true || data.status === "healthy";
    return {
      healthy,
      version: data.version,
      ...(!healthy ? { error: `Proxy status: ${JSON.stringify(data)}` } : {}),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { healthy: false, error: `Proxy unreachable: ${error}` };
  }
}

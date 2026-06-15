// Health check for headroom proxy
import { PROXY_BASE_URL } from "./compression-modes.js";

export async function checkProxyHealth(): Promise<{ healthy: boolean; error?: string; version?: string }> {
  try {
    const response = await fetch(`${PROXY_BASE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      return { healthy: false, error: `Proxy returned ${response.status}` };
    }

    const data = (await response.json()) as { status?: string; version?: string };
    return {
      healthy: data.status === "healthy",
      version: data.version,
      ...(data.status !== "healthy" ? { error: `Proxy status: ${data.status}` } : {}),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { healthy: false, error: `Proxy unreachable: ${error}` };
  }
}

export type CompressionMode = "mcp" | "proxy" | "none";

export const PROXY_PORT = 8787;
// Host-side URL (for health checks from the forge process itself)
export const PROXY_BASE_URL = `http://localhost:${PROXY_PORT}`;
// Container-side URL: Docker containers reach the host via host.docker.internal
export const PROXY_CONTAINER_URL = `http://host.docker.internal:${PROXY_PORT}`;

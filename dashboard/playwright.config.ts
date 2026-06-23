import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:18765",
    trace: "off",
  },
  // Boot the dashboard server once for the entire E2E run.
  // FORGE_HOME points to a non-existent dir: the server starts fine without
  // forge.db because all API routes are intercepted by page.route() in each
  // spec, so db() is never called.
  webServer: {
    command: "tsx src/server.ts",
    url: "http://127.0.0.1:18765/",
    reuseExistingServer: false,
    env: {
      PORT: "18765",
      HOST: "127.0.0.1",
      FORGE_HOME: "/tmp/forge-pw-e2e",
    },
    timeout: 15_000,
    stdout: "ignore",
    stderr: "ignore",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  reporter: [["list"]],
  timeout: 30_000,
});

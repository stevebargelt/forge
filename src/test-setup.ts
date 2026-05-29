import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "forge-test-"));
process.env["FORGE_HOME"] = tempHome;

// Neutralize notification providers for the whole suite. Both ntfy and twilio
// gate on FORGE_NOTIFY containing their name (notify/ntfy.ts, notify/twilio.ts),
// so clearing it makes isAnyProviderEnabled() false. Without this, every test
// that transitions a run to complete/failed fires a REAL push to whoever's
// FORGE_NOTIFY/NTFY_URL is set in the shell running the tests. #170 isolated
// the test DB; this isolates the notification side-effect.
process.env["FORGE_NOTIFY"] = "";

process.on("exit", () => {
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

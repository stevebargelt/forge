import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempHome = mkdtempSync(join(tmpdir(), "forge-test-"));
process.env["FORGE_HOME"] = tempHome;

// FG-374: integration tests use hardcoded /tmp/<name> project dirs as
// placeholders. With preflightProjectMount now active on both invoke and
// runNext paths, these dirs must exist before any test runs.
for (const dir of [
  "/tmp/test-project",
  "/tmp/x",
  "/tmp/proj",
  "/tmp/some-project",
  "/tmp/integ-manifest-project",
  "/tmp/fg364-test-project",
  "/tmp/fg368-test-project",
  "/tmp/fg371-test-project",
  "/tmp/fg371-retry-once-test",
]) {
  mkdirSync(dir, { recursive: true });
}

// #198: silence notifications for the whole suite via the explicit, provider-
// agnostic kill switch. NO_NOTIFY=true short-circuits isAnyProviderEnabled() and
// dispatch() regardless of FORGE_NOTIFY / NTFY_URL / TWILIO_* — so even a test
// that sets a provider env won't fire a REAL push. This is the explicit
// successor to #175's implicit "clear FORGE_NOTIFY" trick (kept below as
// defense-in-depth). #170 isolated the test DB; this isolates the notification
// side-effect.
process.env["NO_NOTIFY"] = "true";
process.env["FORGE_NOTIFY"] = "";

process.on("exit", () => {
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

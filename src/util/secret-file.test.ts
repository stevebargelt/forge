import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeSecretFile } from "./secret-file.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "forge-secret-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("writeSecretFile: creates the file mode 0600 with the right content, no temp left", () => {
  const p = join(dir, "auth-state.json");
  writeSecretFile(p, '{"bearer":"x"}');
  assert.equal(statSync(p).mode & 0o777, 0o600, "must be owner-only");
  assert.equal(readFileSync(p, "utf8"), '{"bearer":"x"}');
  assert.deepEqual(readdirSync(dir), ["auth-state.json"], "no leftover .tmp file");
});

test("writeSecretFile: overwriting a pre-existing world-readable file ends at 0600", () => {
  const p = join(dir, "auth-state.json");
  writeFileSync(p, "old", { mode: 0o644 }); // simulate a looser pre-existing file
  writeSecretFile(p, "new");
  assert.equal(statSync(p).mode & 0o777, 0o600, "atomic rename replaces it at 0600");
  assert.equal(readFileSync(p, "utf8"), "new");
});

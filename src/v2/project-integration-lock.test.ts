import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectIntegrationLockKey, withProjectIntegrationLock } from "./project-integration-lock.js";

// ── FG-425: lock keying (pure path logic — no waits, no subprocesses) ────────

test("FG-425 key: trailing-slash and exact spellings of one directory key the same lock file", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg425-key-"));
  try {
    const a = projectIntegrationLockKey(dir);
    const b = projectIntegrationLockKey(dir + "/");
    assert.equal(a.lockFilePath, b.lockFilePath);
    assert.equal(a.canonicalDir, b.canonicalDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-425 key: a symlink to the project keys the SAME lock file as the physical path", () => {
  const real = mkdtempSync(join(tmpdir(), "forge-fg425-real-"));
  const linkParent = mkdtempSync(join(tmpdir(), "forge-fg425-link-"));
  const link = join(linkParent, "aliased-project");
  try {
    symlinkSync(real, link);
    const viaReal = projectIntegrationLockKey(real);
    const viaLink = projectIntegrationLockKey(link);
    assert.equal(viaLink.lockFilePath, viaReal.lockFilePath, "two spellings of one repo must exclude each other");
    assert.equal(viaLink.canonicalDir, viaReal.canonicalDir);
  } finally {
    rmSync(linkParent, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("FG-425 key: different directories key DIFFERENT lock files (independent projects stay parallel)", () => {
  const a = mkdtempSync(join(tmpdir(), "forge-fg425-a-"));
  const b = mkdtempSync(join(tmpdir(), "forge-fg425-b-"));
  try {
    assert.notEqual(projectIntegrationLockKey(a).lockFilePath, projectIntegrationLockKey(b).lockFilePath);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("FG-425 key: an unresolvable path still keys deterministically (resolve fallback)", () => {
  const ghost = join(tmpdir(), "forge-fg425-does-not-exist", "nested");
  const a = projectIntegrationLockKey(ghost);
  const b = projectIntegrationLockKey(ghost);
  assert.equal(a.lockFilePath, b.lockFilePath);
});

// ── FG-425: undefined projectDir = passthrough (non-worktree dispatch path) ──

test("FG-425: projectDir undefined runs fn directly and creates no lock file", async () => {
  let ran = false;
  const out = await withProjectIntegrationLock(undefined, "run-x", async () => {
    ran = true;
    return "value";
  });
  assert.equal(out, "value");
  assert.equal(ran, true);
});

test("FG-425: the lock file exists while held and is gone after release (incl. after a throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg425-hold-"));
  const { lockFilePath } = projectIntegrationLockKey(dir);
  try {
    await withProjectIntegrationLock(dir, "run-hold", async () => {
      assert.equal(existsSync(lockFilePath), true, "held during fn");
    });
    assert.equal(existsSync(lockFilePath), false, "released after fn");

    await assert.rejects(
      withProjectIntegrationLock(dir, "run-throw", async () => {
        throw new Error("gate exploded");
      }),
      /gate exploded/,
    );
    assert.equal(existsSync(lockFilePath), false, "released deterministically on a thrown error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

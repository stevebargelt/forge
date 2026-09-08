import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRemotePortRequiresRemote } from "./dashboard.js";

// RF-6 (FG-781 AC1): `--remote-port` is documented as requiring `--remote`. The CLI must
// ENFORCE that prerequisite, not silently accept the port and ignore it.

test("assertRemotePortRequiresRemote: --remote-port without --remote is refused, by name", () => {
  assert.throws(
    () => assertRemotePortRequiresRemote({ remotePort: "8025" }),
    /--remote-port requires --remote/,
  );
  assert.throws(
    () => assertRemotePortRequiresRemote({ remotePort: "8025", remote: false }),
    /--remote-port requires --remote/,
  );
});

test("assertRemotePortRequiresRemote: --remote-port WITH --remote is accepted", () => {
  assert.doesNotThrow(() => assertRemotePortRequiresRemote({ remote: true, remotePort: "8025" }));
});

test("assertRemotePortRequiresRemote: neither flag, or --remote alone, is accepted", () => {
  assert.doesNotThrow(() => assertRemotePortRequiresRemote({}));
  assert.doesNotThrow(() => assertRemotePortRequiresRemote({ remote: true }));
});

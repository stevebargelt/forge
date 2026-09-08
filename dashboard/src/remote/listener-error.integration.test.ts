// FG-781 AC1 / RF-2 — a remote-listener bind failure must NEVER take the local dashboard down.
//
// The remote listener binds asynchronously, so a bind error (EADDRINUSE, EACCES, …) is emitted
// on the server AFTER startRemoteBoardServer returns — the caller's synchronous try/catch
// cannot catch it. Without an 'error' handler that unhandled event would crash the SHARED
// dashboard process. This occupies the port first, starts the remote server on it, and proves
// the failure is contained: the listener is torn down and the process stays alive (the test
// completing past the async error IS the containment proof — an unhandled 'error' would abort
// the run with an uncaughtException).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { startRemoteBoardServer } from "./server.js";
import { REMOTE_LOOPBACK_HOST, type RemoteBoardConfig } from "./config.js";

const cleanup: Server[] = [];
after(() => {
  for (const srv of cleanup) srv.close();
});

test("RF-2: a remote-listener bind failure is contained, leaving the local dashboard process alive", async () => {
  // Occupy an ephemeral loopback port so the remote listener's bind is guaranteed to fail.
  const blocker = createServer(() => {});
  cleanup.push(blocker);
  await new Promise<void>((ready) => blocker.listen(0, REMOTE_LOOPBACK_HOST, () => ready()));
  const port = (blocker.address() as AddressInfo).port;

  const config: RemoteBoardConfig = { enabled: true, host: REMOTE_LOOPBACK_HOST, port };
  const remote = startRemoteBoardServer(config);
  cleanup.push(remote);

  // The bind fails asynchronously; the module's error handler must catch it and close the
  // half-open listener. Waiting on 'close' proves the handler ran — and that we got here at
  // all proves the error did not crash the process.
  await new Promise<void>((resolve, reject) => {
    remote.once("close", () => resolve());
    setTimeout(() => reject(new Error("the failed remote listener was not contained (no close within 2s)")), 2000);
  });

  assert.equal(remote.address(), null, "the failed remote listener is torn down, not left half-open");
});

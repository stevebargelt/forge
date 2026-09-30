// FG-841: a fixture server and its client share one event loop. A synchronous CLI call
// can therefore delay both sides' idle timers past the server's keep-alive deadline.
// Fixture requests must opt out of pooling so the post-stall request always gets a new
// connection instead of a stale keep-alive socket.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fixtureFetch } from "./test-support/fixture-fetch.js";

const server = createServer((_req, res) => res.end("ok"));
let connections = 0;
server.on("connection", () => { connections += 1; });

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const address = server.address();
assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/`;

function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test("FG-841: fixtureFetch never reuses a keep-alive socket after a synchronous stall", async () => {
  const first = await fixtureFetch(url);
  assert.equal(await first.text(), "ok");

  // The production flake needs a >5 s synchronous CLI call. Keep the same interval so
  // this remains a regression test for the actual stale-socket window.
  blockEventLoop(5_100);

  const second = await fixtureFetch(url);
  assert.equal(await second.text(), "ok");
  assert.equal(connections, 2, "Connection: close makes the post-stall request use a fresh socket");
});

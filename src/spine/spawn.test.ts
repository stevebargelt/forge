import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { startIdleWatchdog } from "./spawn.js";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("idle watchdog: fires when stream stays silent", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  startIdleWatchdog(stream, 30, () => {
    fired++;
  });
  await delay(80);
  assert.equal(fired, 1, "should have fired once");
});

test("idle watchdog: does not fire while data keeps arriving", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  startIdleWatchdog(stream, 50, () => {
    fired++;
  });
  // Push every 20ms — gap stays under 50ms.
  for (let i = 0; i < 5; i++) {
    stream.push(Buffer.from(`chunk-${i}`));
    await delay(20);
  }
  assert.equal(fired, 0, "should not have fired while data was arriving");
});

test("idle watchdog: fires after stream goes silent following activity", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  startIdleWatchdog(stream, 30, () => {
    fired++;
  });
  stream.push(Buffer.from("hello"));
  await delay(10);
  stream.push(Buffer.from("world"));
  // Now silent — should fire after another ~30ms.
  await delay(80);
  assert.equal(fired, 1, "should fire once after silence resumes");
});

test("idle watchdog: stop() prevents firing", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  const w = startIdleWatchdog(stream, 30, () => {
    fired++;
  });
  w.stop();
  await delay(80);
  assert.equal(fired, 0, "should not fire after stop()");
});

test("idle watchdog: only fires once even on long silence", async () => {
  const stream = new Readable({ read() {} });
  let fired = 0;
  startIdleWatchdog(stream, 20, () => {
    fired++;
  });
  await delay(120);
  assert.equal(fired, 1, "should fire exactly once");
});

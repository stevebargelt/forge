import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { finishUnhandledRequest, degradedGraphErrorPayload } from "./http-error.js";

test("an unhandled error before headers returns a sanitized JSON 500", () => {
  let status = 0;
  let body = "";
  let destroyed = false;
  const response = {
    headersSent: false,
    writeHead(code: number) { status = code; return this; },
    end(value?: string) { body = value ?? ""; return this; },
    destroy() { destroyed = true; return this; },
  } as unknown as ServerResponse;

  finishUnhandledRequest(response);
  assert.equal(status, 500);
  assert.equal(body, JSON.stringify({ error: "Internal server error" }));
  assert.equal(destroyed, false);
});

test("RF-3: the degraded config-graph error payload redacts a secret in the exception message", () => {
  const payload = degradedGraphErrorPayload(new Error("build failed: NPM_TOKEN=supersecretvalue123 was rejected"));
  const parsed = JSON.parse(payload) as { error: string };
  assert.equal(parsed.error.includes("supersecretvalue123"), false, "the secret must be blanked");
  assert.match(parsed.error, /build failed/, "the non-secret context is preserved");
});

test("degradedGraphErrorPayload stringifies a non-Error thrown value", () => {
  const payload = degradedGraphErrorPayload("plain string failure");
  assert.deepEqual(JSON.parse(payload), { error: "plain string failure" });
});

test("an unhandled error after headers destroys instead of appending JSON", () => {
  let ended = false;
  let destroyed = false;
  const response = {
    headersSent: true,
    writeHead() { throw new Error("must not write headers twice"); },
    end() { ended = true; return this; },
    destroy() { destroyed = true; return this; },
  } as unknown as ServerResponse;

  finishUnhandledRequest(response);
  assert.equal(destroyed, true);
  assert.equal(ended, false);
});

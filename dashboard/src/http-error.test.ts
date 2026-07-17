import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { finishUnhandledRequest } from "./http-error.js";

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

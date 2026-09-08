// FG-785: unit tests for the provider-neutral adapter CONTRACT. Pure — no process, no DB.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  KANBAN_CAPABILITIES,
  KanbanContractError,
  assertIdempotencyKey,
  capabilityForOp,
  supportsCapability,
  type CapabilityDeclaration,
  type OutboundOperation,
} from "./adapter.js";

const identity = { projectKey: "forge", ticketId: "FG-785" };

function createOp(over: Partial<Extract<OutboundOperation, { kind: "create" }>> = {}): OutboundOperation {
  return {
    kind: "create",
    idempotencyKey: "key-1",
    content: {
      identity,
      laneId: "backlog",
      title: "title",
      body: null,
      labels: [],
      projectionRevision: "rev-1",
    },
    ...over,
  };
}

describe("capability declaration — a provider states what it does NOT support", () => {
  test("a capability absent from `unsupported` is a commitment", () => {
    const decl: CapabilityDeclaration = { unsupported: ["archive"] };
    assert.equal(supportsCapability(decl, "create"), true);
    assert.equal(supportsCapability(decl, "update"), true);
    assert.equal(supportsCapability(decl, "archive"), false);
  });

  test("an empty unsupported set commits to everything", () => {
    const decl: CapabilityDeclaration = { unsupported: [] };
    for (const cap of KANBAN_CAPABILITIES) {
      assert.equal(supportsCapability(decl, cap), true, `${cap} committed`);
    }
  });

  test("capabilityForOp maps each op kind to its required capability", () => {
    assert.equal(capabilityForOp("create"), "create");
    assert.equal(capabilityForOp("update"), "update");
    assert.equal(capabilityForOp("archive"), "archive");
  });
});

describe("idempotency key is required on every outbound operation", () => {
  test("a well-formed key passes", () => {
    assert.doesNotThrow(() => assertIdempotencyKey(createOp()));
  });

  test("an empty key is a contract violation, thrown — not a soft outcome", () => {
    assert.throws(() => assertIdempotencyKey(createOp({ idempotencyKey: "" })), KanbanContractError);
  });

  test("a whitespace-only key is a contract violation", () => {
    assert.throws(() => assertIdempotencyKey(createOp({ idempotencyKey: "   " })), KanbanContractError);
  });

  test("update and archive ops also require a key", () => {
    const update: OutboundOperation = {
      kind: "update",
      idempotencyKey: "",
      externalId: "x",
      content: createOp().kind === "create" ? (createOp() as Extract<OutboundOperation, { kind: "create" }>).content : {
        identity, laneId: "backlog", title: "t", body: null, labels: [], projectionRevision: "r",
      },
    };
    assert.throws(() => assertIdempotencyKey(update), KanbanContractError);

    const archive: OutboundOperation = {
      kind: "archive",
      idempotencyKey: "",
      externalId: "x",
      identity,
      projectionRevision: "r",
    };
    assert.throws(() => assertIdempotencyKey(archive), KanbanContractError);
  });
});

describe("identity discipline — the opaque pair is the only identity", () => {
  test("KANBAN_CAPABILITIES is the closed capability vocabulary", () => {
    assert.deepEqual([...KANBAN_CAPABILITIES], ["create", "update", "archive", "lanes", "labels", "body"]);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import { hashForView, initialView } from "../client/view-routing.js";

test("home is the default view for an empty or unknown hash", () => {
  assert.equal(initialView(""), "home");
  assert.equal(initialView("#"), "home");
  assert.equal(initialView("#unknown"), "home");
});

test("known view hashes remain directly addressable", () => {
  assert.equal(initialView("#activity"), "activity");
  assert.equal(initialView("#usage"), "usage");
  assert.equal(initialView("#governance"), "governance");
});

test("home owns the hashless route while other views retain explicit hashes", () => {
  assert.equal(hashForView("home"), "");
  assert.equal(hashForView("activity"), "#activity");
  assert.equal(hashForView("usage"), "#usage");
});

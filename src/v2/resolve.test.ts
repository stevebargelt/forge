import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { substitute, substituteOptional, expandTilde } from "./resolve.js";

let envSnap: Record<string, string | undefined>;

beforeEach(() => {
  envSnap = {
    AWS_REGION: process.env.AWS_REGION,
    FORGE_BROWSER_TOOLS_DIR: process.env.FORGE_BROWSER_TOOLS_DIR,
    NO_SUCH_VAR_XYZ: process.env.NO_SUCH_VAR_XYZ,
  };
  for (const k of Object.keys(envSnap)) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("substitute: replaces ${VAR} from context", () => {
  assert.equal(substitute("hello ${NAME}", { NAME: "world" }), "hello world");
});

test("substitute: replaces from process.env when context lacks the key", () => {
  process.env.AWS_REGION = "us-west-2";
  assert.equal(substitute("region=${AWS_REGION}", {}), "region=us-west-2");
});

test("substitute: context takes priority over env", () => {
  process.env.AWS_REGION = "from-env";
  assert.equal(substitute("region=${AWS_REGION}", { AWS_REGION: "from-ctx" }), "region=from-ctx");
});

test("substitute: ${VAR:-default} uses default when var unset", () => {
  assert.equal(substitute("region=${AWS_REGION:-us-east-1}", {}), "region=us-east-1");
});

test("substitute: ${VAR:-default} uses var when set non-empty", () => {
  assert.equal(substitute("region=${AWS_REGION:-us-east-1}", { AWS_REGION: "ap-northeast-1" }), "region=ap-northeast-1");
});

test("substitute: ${VAR:-default} uses default when var is empty string", () => {
  // Empty-string env vars are treated as unset for substitution purposes.
  assert.equal(substitute("x=${EMPTY:-fb}", { EMPTY: "" }), "x=fb");
});

test("substitute: missing var without default throws with the var name", () => {
  assert.throws(
    () => substitute("hi ${NOPE}", {}),
    /\${NOPE}.*not defined/
  );
});

test("substitute: handles multiple substitutions in one template", () => {
  assert.equal(
    substitute("${A}/${B}/${C:-cee}", { A: "alpha", B: "beta" }),
    "alpha/beta/cee"
  );
});

test("substituteOptional: missing required var returns undefined (no throw)", () => {
  assert.equal(substituteOptional("dir=${MISSING}", {}), undefined);
});

test("substituteOptional: present var returns the substituted string", () => {
  assert.equal(substituteOptional("dir=${X}", { X: "hello" }), "dir=hello");
});

test("substituteOptional: empty result returns undefined", () => {
  // If the only substitution resolves to empty, the whole template's empty;
  // treat as 'don't use this'. Matches the optional-mount semantic.
  assert.equal(substituteOptional("${EMPTY}", { EMPTY: "" }), undefined);
});

test("expandTilde: ~ alone expands to homedir", () => {
  assert.equal(expandTilde("~"), homedir());
});

test("expandTilde: ~/foo expands to homedir/foo", () => {
  assert.equal(expandTilde("~/foo"), `${homedir()}/foo`);
});

test("expandTilde: no leading ~ passes through unchanged", () => {
  assert.equal(expandTilde("/abs/path"), "/abs/path");
  assert.equal(expandTilde("relative/path"), "relative/path");
  assert.equal(expandTilde("/a~tilde-mid-path"), "/a~tilde-mid-path");
});

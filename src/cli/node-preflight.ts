// FG-336 / FG-570 (FG-553 Child 3): ABI preflight for the forge CLI.
//
// better-sqlite3's native binding is built for ONE ABI (NODE_MODULE_VERSION) and
// loads under that ABI ONLY — it is not range-compatible. A minimum-major floor
// (the original FG-336 shape) caught the too-old case but WAVED UPGRADES THROUGH:
// Node 26 (ABI 147) passed `major >= 24` and then died inside the native loader
// with an opaque "NODE_MODULE_VERSION 137 ... requires 147" crash. So the check is
// EQUALITY against the ABI the shipped binding actually needs — an upper AND a
// lower bound.
//
// This module runs its check at IMPORT TIME and must be the FIRST import in the
// CLI entry (src/cli/index.ts), before any module that transitively requires
// better-sqlite3 — otherwise the native-binding crash beats us to it. For the same
// reason its own import graph must stay NATIVE-FREE: src/v2/release.ts is imported
// only for readReleaseManifest and requires better-sqlite3 lazily, inside function
// bodies (see node-preflight.test.ts, which proves the graph loads no binding).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_MANIFEST_NAME, locateReleaseManifest } from "../v2/release.js";

// The ABI of the interpreter a dev checkout's node_modules is built for. Tracks
// .nvmrc / package.json engines — bump together when the repo moves LTS. A RELEASE
// does not use this: it carries the exact ABI of its own shipped binding on its
// manifest (ReleaseManifest.abi), which takes priority.
export const REQUIRED_ABI = "137";

/** Pure check: can a native binding built for `expectedAbi` load under `actualAbi`?
 *  Only if they are the same ABI. Both an expected ABI we could not read and a known
 *  mismatch are real blocks: passing on an ABI we never determined would start the CLI
 *  under an unverified interpreter and hand the operator the opaque native-loader crash
 *  this preflight exists to preempt. */
export function checkAbi(actualAbi: string, expectedAbi: string): { ok: true } | { ok: false; message: string } {
  const expected = expectedAbi.trim();
  const actual = actualAbi.trim();
  if (expected === "" || !Number.isFinite(Number.parseInt(expected, 10))) {
    return {
      ok: false,
      message:
        `forge: refusing to run — cannot determine the ABI forge's native modules need.\n` +
        `  running:  Node ${process.versions.node}, ABI ${actual || "(unreadable)"}\n` +
        `  required: ${expectedAbi.trim() === "" ? "(missing)" : `(unreadable: ${expectedAbi})`}\n` +
        `An unverified ABI cannot be waved through: forge's better-sqlite3 binding loads under ` +
        `its own ABI only, so starting anyway would fail inside the native loader instead of here.\n` +
        `Fix: reinstall forge from a release that states its ABI, or run from the checkout it pins ` +
        `(\`nvm use\` in the repo root, which reads .nvmrc).`,
    };
  }
  if (actual === expected) return { ok: true };

  const actualN = Number.parseInt(actual, 10);
  const expectedN = Number.parseInt(expected, 10);
  const direction = !Number.isFinite(actualN)
    ? `a different ABI (${actual || "unreadable"})`
    : actualN > expectedN
      ? `a NEWER ABI (${actual})`
      : `an OLDER ABI (${actual})`;
  return {
    ok: false,
    message:
      `forge: refusing to run — this Node cannot load forge's native modules.\n` +
      `  running:  Node ${process.versions.node}, ABI ${actual || "(unreadable)"}\n` +
      `  required: ABI ${expected}\n` +
      `forge's better-sqlite3 binding is compiled for ABI ${expected}; you are on ${direction}. ` +
      `A binding loads under its own ABI only — newer is as incompatible as older.\n` +
      `Fix: switch to the Node this checkout pins (\`nvm use\` in the repo root, which reads .nvmrc), ` +
      `or re-run forge from the interpreter that matches ABI ${expected}.`,
  };
}

/** The ABI the binding forge is about to load actually needs: a release states it on
 *  its own manifest (the release ships the binding, so its manifest is authoritative);
 *  a dev checkout has no manifest and falls back to the pinned constant. A release whose
 *  manifest ABI is missing or unusable is REFUSED by name — it ships a binding whose ABI
 *  we cannot verify, and the pinned dev constant is not evidence about it. A manifest that
 *  is present but UNPARSEABLE is the same refusal: it is a release, so the dev fallback is
 *  no more applicable to it than to one whose `abi` field is garbage. */
export function resolveExpectedAbi(
  found: { kind: "none" } | { kind: "release"; manifest: { abi?: unknown }; releaseDir: string } | { kind: "malformed"; releaseDir: string; error: string },
): { ok: true; abi: string } | { ok: false; message: string } {
  if (found.kind === "none") return { ok: true, abi: REQUIRED_ABI };
  if (found.kind === "malformed") {
    return {
      ok: false,
      message:
        `forge: refusing to run — this release's manifest is unreadable.\n` +
        `  release:  ${join(found.releaseDir, RELEASE_MANIFEST_NAME)}\n` +
        `  parse error: ${found.error}\n` +
        `  running:  Node ${process.versions.node}, ABI ${process.versions.modules}\n` +
        `This release ships its own better-sqlite3 binding, and its manifest is the only ` +
        `authority on the ABI that binding needs. A manifest forge cannot parse states nothing, ` +
        `so starting anyway would fail inside the native loader with an opaque ABI-mismatch ` +
        `crash instead of failing clean here.\n` +
        `Fix: reinstall from a release built by \`forge release\`, or run forge from a source checkout.`,
    };
  }

  // `abi` is typed string but nothing enforces it: readReleaseManifest JSON.parses with
  // a bare cast, so a hand-written manifest's unquoted `"abi": 137` arrives as a number.
  // Coerce rather than trust the type — a numeric 137 is genuinely compatible on an
  // ABI-137 interpreter and must RUN.
  const raw: unknown = found.manifest.abi;
  const abi = raw != null ? String(raw).trim() : "";
  if (abi === "" || !Number.isFinite(Number.parseInt(abi, 10))) {
    return {
      ok: false,
      message:
        `forge: refusing to run — this release does not state a usable ABI.\n` +
        `  release:  ${join(found.releaseDir, RELEASE_MANIFEST_NAME)}\n` +
        `  manifest abi: ${raw === undefined ? "(missing)" : JSON.stringify(raw)}\n` +
        `  running:  Node ${process.versions.node}, ABI ${process.versions.modules}\n` +
        `This release ships its own better-sqlite3 binding, so its manifest is the only ` +
        `authority on the ABI that binding needs. Without it forge cannot tell whether this ` +
        `interpreter can load the binding, and starting anyway would fail inside the native ` +
        `loader with an opaque ABI-mismatch crash instead of failing clean here.\n` +
        `Fix: reinstall from a release built by \`forge release\` (it records \`abi\`), or run ` +
        `forge from a source checkout.`,
    };
  }
  return { ok: true, abi };
}

/** FG-571 — RELEASE IDENTITY, RE-VALIDATED AFTER STARTUP, IN TRUSTED NODE.
 *
 *  The machine-wide shim exports FORGE_RELEASE_ID from the release unit's canonical execution
 *  descriptor, which it validates with POSIX sh. That is enough to exec safely — the shim
 *  reads only forge-authored data — but it is not enough to make the exported id
 *  AUTHORITATIVE: `forge-release.json` remains the authority on what a release IS, and it is
 *  parsed by exactly one parser, JSON.parse, right here.
 *
 *  So the id the shim carried in is checked against the id the manifest actually states, by
 *  the parser that owns that question, before any command runs. If the two disagree, then the
 *  unit forge validated and the identity the machine is about to record as provenance are
 *  different things — a named, fail-closed refusal, never a reconciliation and never a
 *  silent preference for one side.
 *
 *  ABSENT is not a mismatch. A direct `node <release>/src/cli/index.ts` invocation and the
 *  dev entry (bin/forge-dev, which has no manifest) both legitimately carry no id, and
 *  FG-569's rule holds: not recorded, never manufactured. Only a PRESENT-and-DIFFERENT id is
 *  a contradiction, and only that is refused. */
export function checkReleaseIdentity(
  found: { kind: "none" } | { kind: "release"; manifest: { id?: unknown }; releaseDir: string } | { kind: "malformed"; releaseDir: string; error: string },
  carried: string | undefined,
): { ok: true } | { ok: false; message: string } {
  if (found.kind !== "release" || carried === undefined) return { ok: true };
  const stated = found.manifest.id;
  if (typeof stated === "string" && stated === carried) return { ok: true };
  return {
    ok: false,
    message:
      `forge: refusing to run — this release's execution descriptor and its manifest disagree about its identity.\n` +
      `  release manifest: ${join(found.releaseDir, RELEASE_MANIFEST_NAME)}\n` +
      `  manifest id:      ${stated === undefined ? "(missing)" : JSON.stringify(stated)}\n` +
      `  launched as:      ${JSON.stringify(carried)}\n` +
      `  running:          Node ${process.versions.node}, ABI ${process.versions.modules}\n` +
      `The manifest is the only authority on what this release IS, and forge re-checks it here — with the ` +
      `one parser that owns that question — against the identity the launcher carried in. A release that ` +
      `cannot agree with itself about who it is would record false provenance for every process it starts, ` +
      `so it does not run.\n` +
      `Fix: re-promote this release — \`forge release promote <dir|id>\` — or roll back to the previous ` +
      `release: \`forge release rollback\`.`,
  };
}

/** Run the checks against the live runtime; print + exit(1) on a mismatch. Invoked
 *  at import time so the CLI fails clean BEFORE better-sqlite3 is required. */
export function applyNodePreflight(): void {
  const found = locateReleaseManifest(dirname(fileURLToPath(import.meta.url)));
  const expected = resolveExpectedAbi(found);
  const r = expected.ok ? checkAbi(process.versions.modules, expected.abi) : expected;
  if (!r.ok) {
    process.stderr.write(`${r.message}\n`);
    process.exit(1);
  }
  const identity = checkReleaseIdentity(found, process.env.FORGE_RELEASE_ID);
  if (!identity.ok) {
    process.stderr.write(`${identity.message}\n`);
    process.exit(1);
  }
}

applyNodePreflight();

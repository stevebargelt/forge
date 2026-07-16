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
import { RELEASE_MANIFEST_NAME, readReleaseManifest } from "../v2/release.js";

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
 *  we cannot verify, and the pinned dev constant is not evidence about it. */
export function resolveExpectedAbi(
  found: { manifest: { abi?: unknown }; releaseDir: string } | null,
): { ok: true; abi: string } | { ok: false; message: string } {
  if (!found) return { ok: true, abi: REQUIRED_ABI };

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

/** Run the check against the live runtime; print + exit(1) on a mismatch. Invoked
 *  at import time so the CLI fails clean BEFORE better-sqlite3 is required. */
export function applyNodePreflight(): void {
  const expected = resolveExpectedAbi(readReleaseManifest(dirname(fileURLToPath(import.meta.url))));
  const r = expected.ok ? checkAbi(process.versions.modules, expected.abi) : expected;
  if (!r.ok) {
    process.stderr.write(`${r.message}\n`);
    process.exit(1);
  }
}

applyNodePreflight();

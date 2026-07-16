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

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseManifest } from "../v2/release.js";

// The ABI of the interpreter a dev checkout's node_modules is built for. Tracks
// .nvmrc / package.json engines — bump together when the repo moves LTS. A RELEASE
// does not use this: it carries the exact ABI of its own shipped binding on its
// manifest (ReleaseManifest.abi), which takes priority.
export const REQUIRED_ABI = "137";

/** Pure check: can a native binding built for `expectedAbi` load under `actualAbi`?
 *  Only if they are the same ABI. An expected ABI we could not read fails OPEN (ok)
 *  — never manufacture a block from a value we couldn't determine. A known mismatch
 *  is always a real block. */
export function checkAbi(actualAbi: string, expectedAbi: string): { ok: true } | { ok: false; message: string } {
  const expected = expectedAbi.trim();
  const actual = actualAbi.trim();
  if (expected === "" || !Number.isFinite(Number.parseInt(expected, 10))) return { ok: true };
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
 *  a dev checkout has no manifest and falls back to the pinned constant. */
function expectedAbi(): string {
  const found = readReleaseManifest(dirname(fileURLToPath(import.meta.url)));
  return found?.manifest.abi ?? REQUIRED_ABI;
}

/** Run the check against the live runtime; print + exit(1) on a mismatch. Invoked
 *  at import time so the CLI fails clean BEFORE better-sqlite3 is required. */
export function applyNodePreflight(): void {
  const r = checkAbi(process.versions.modules, expectedAbi());
  if (!r.ok) {
    process.stderr.write(`${r.message}\n`);
    process.exit(1);
  }
}

applyNodePreflight();

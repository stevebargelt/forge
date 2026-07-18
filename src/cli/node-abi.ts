// FG-570 / FG-555: the bounded ABI-equality assertion, extracted into a
// SIDE-EFFECT-FREE module.
//
// `checkAbi` is FG-570's mechanism: a native binding built for one ABI
// (NODE_MODULE_VERSION) loads under that ABI ONLY — not range-compatible — so
// the check is EQUALITY (upper AND lower bound), never a version floor. It lived
// in node-preflight.ts, which runs `applyNodePreflight()` at IMPORT TIME (it must,
// to fail clean before better-sqlite3 loads). Any module that wanted to REUSE the
// assertion — FG-555's launch-toolchain refusal does — could not import it without
// triggering that import-time exit. So the pure check moves here; node-preflight.ts
// re-exports it, and FG-555 imports it here with no side effect and no second
// ABI checker.

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

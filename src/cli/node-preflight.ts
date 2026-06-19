// FG-336: Node-version preflight for the forge CLI.
//
// better-sqlite3 v12's native binding is built for the repo's Node 24
// (NODE_MODULE_VERSION 137, pinned by .nvmrc). A shell that resolves an older
// Node — typically a non-login / VS Code terminal landing on Node 20 (ABI 115) —
// makes the binding throw an opaque "NODE_MODULE_VERSION 137 ... requires 115"
// error with no hint about the cause or the fix.
//
// This module runs its check at IMPORT TIME and must be the FIRST import in the
// CLI entry (src/cli/index.ts), before any module that transitively requires
// better-sqlite3 — otherwise the native-binding crash beats us to it. It is a
// minimum-major guard: it catches the common too-old case (the only one seen in
// the wild); a newer Node that also lacks a matching prebuilt is out of scope.

// Tracks .nvmrc / package.json engines. Bump together when the repo moves LTS.
export const REQUIRED_NODE_MAJOR = 24;

/** Pure check: is `nodeVersion` (e.g. "20.18.2" or "v20.18.2") new enough? An
 *  unparseable version fails OPEN (ok) — never block on a version string we
 *  can't read. */
export function checkNodeVersion(
  nodeVersion: string,
  requiredMajor: number = REQUIRED_NODE_MAJOR,
): { ok: true } | { ok: false; message: string } {
  const major = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major >= requiredMajor) return { ok: true };
  return {
    ok: false,
    message:
      `forge requires Node >=${requiredMajor} — you're on Node ${nodeVersion}.\n` +
      `better-sqlite3's native binding is built for Node ${requiredMajor} and will not load on this version.\n` +
      `Fix: run \`nvm use ${requiredMajor}\` (the repo's .nvmrc pins it), then re-run forge.`,
  };
}

/** Run the check against the live runtime; print + exit(1) if too old. Invoked
 *  at import time so the CLI fails clean BEFORE better-sqlite3 is required. */
export function applyNodePreflight(): void {
  const r = checkNodeVersion(process.versions.node);
  if (!r.ok) {
    process.stderr.write(`${r.message}\n`);
    process.exit(1);
  }
}

applyNodePreflight();

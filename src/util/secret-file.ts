// Write a credential-bearing file so it is NEVER briefly world/group-readable —
// even when the parent dir is 0777 (task dirs are). The old pattern
// (writeFileSync then chmodSync) leaves a TOCTOU window between create and chmod
// during which the file carries default-umask perms.
//
// Here: write to a temp path created mode 0600 (no window), enforce 0600, then
// atomically rename into place. The final path never exists with loose perms.

import { writeFileSync, chmodSync, renameSync, unlinkSync } from "node:fs";

export function writeSecretFile(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 }); // created 0600 (mode & ~umask) — no readable window
    chmodSync(tmp, 0o600);                      // defense: enforce even if the temp pre-existed
    renameSync(tmp, path);                      // atomic swap; final file inherits 0600
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup of a partial temp */ }
    throw e;
  }
}

// Write a credential-bearing file so it is NEVER briefly world/group-readable —
// even when the parent dir is 0777 (task dirs are).
//
// Hardening against a hostile 0777 dir (a symlink or pre-created file at a
// predictable temp path could otherwise redirect/observe the write): use a
// RANDOM same-directory temp name and an EXCLUSIVE create — openSync "wx" =
// O_WRONLY|O_CREAT|O_EXCL, mode 0600. O_EXCL fails (won't follow a symlink) if
// the path already exists, so we never write through a planted file. Then write
// via the fd and atomically rename into place — the final path never exists with
// loose perms.

import { openSync, writeSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

export function writeSecretFile(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600); // exclusive create at 0600 — fails if it exists / is a symlink
    writeSync(fd, data);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path); // atomic swap; final file inherits the temp's 0600
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(tmp); } catch { /* best-effort cleanup of a partial temp */ }
    throw e;
  }
}

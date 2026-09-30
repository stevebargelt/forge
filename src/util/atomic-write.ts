import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** Write `data` to `path` via a temp file in the same directory + rename, so a reader
 *  sees either the old bytes or the new bytes, never a partial file. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const fd = openSync(tmp, "wx", 0o644);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

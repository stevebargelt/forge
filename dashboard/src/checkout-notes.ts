// FG-830: one checkout's `backlog/notes.md` as content plus the mtime of THAT revision.
// `forge backlog notes replace|add` rewrites the file in place, so a read and a separate
// stat of the path can straddle a write and pair old content with the new mtime — which
// the Notes view would then show as an undated note's session date. The read goes
// through one descriptor and is bracketed by two fstats; if the file moved underneath
// it, it is re-read, and if it never settles the mtime is reported as unknown (null)
// rather than guessed.

import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";

const ATTEMPTS = 3;

// Positional reads from 0: readFileSync(fd) would resume at the descriptor's offset, so a
// retry would read nothing.
function readWhole(fd: number): string {
  const chunks: Buffer[] = [];
  let position = 0;
  for (;;) {
    const chunk = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, chunk, 0, chunk.length, position);
    if (bytes === 0) break;
    chunks.push(chunk.subarray(0, bytes));
    position += bytes;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sameRevision(a: Stats, b: Stats): boolean {
  return a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino;
}

export function readCheckoutNotes(
  notesPath: string,
  beforeRead: () => void = () => {},
): { notes: string; modifiedAt: string | null } {
  let fd: number;
  try {
    fd = openSync(notesPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { notes: "", modifiedAt: null };
    throw error;
  }
  try {
    let notes = "";
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const before = fstatSync(fd);
      beforeRead();
      notes = readWhole(fd);
      const after = fstatSync(fd);
      if (sameRevision(before, after)) return { notes, modifiedAt: after.mtime.toISOString() };
    }
    return { notes, modifiedAt: null };
  } finally {
    closeSync(fd);
  }
}

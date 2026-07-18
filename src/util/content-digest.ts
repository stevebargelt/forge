// FG-579: the ONE byte-identity mechanism, shared by every place that must decide
// "are these two files the same bytes?". Promoted out of runtime-store.ts's
// private fileDigest (FG-571), so the interpreter store, the seed-drift detector,
// and the workflow-dispatch refusal all commit to the SAME definition of identity
// rather than three createHash call sites that could quietly drift apart.
//
// SHA-256 of BYTES — not of a decoded string. A digest lets a comparison carry the
// 64-hex identity instead of the file's bytes, and byte-hashing (not utf8-string
// compare) is what makes "same file" mean the same thing on every side of a
// shell/TS boundary: a trailing newline or a multibyte codepoint is a byte
// difference, full stop.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** sha256 of the bytes at `path`, hex. Throws if the file cannot be read. */
export function sha256OfBytes(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** sha256 of `s` encoded utf8, hex. For hashing an in-memory payload rather than a
 *  file on disk. */
export function sha256OfString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

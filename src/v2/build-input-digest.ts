// FG-543: the ONE build-input digest, computed identically at build time
// (docker/build.sh, via print-build-input-digest.ts) and at check time
// (doctor.ts). The image's staleness is judged by comparing a freshly-computed
// digest of the build inputs against a digest recorded as an image LABEL at build
// time — content, not mtimes, so a fully-cached rebuild (new image ID, old
// `created` timestamp) and a git pull/checkout (fresh mtimes, same bytes) both
// stop misfiring as STALE.
//
// This function is the single source of truth so the two probes can't drift (cf.
// parseDockerInspectState in failure-kind.ts). If build.sh hashed with bash
// `sha256sum` while doctor hashed in TS, the two would diverge on ordering / file
// set / newline handling and reintroduce the false positives. Both sides call
// THIS. Deliberately depends on node builtins only, so the tiny printer build.sh
// invokes stays cheap and pulls in no DB/native modules.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const DOCKERFILE = "agent-dev-worker.Dockerfile";

// corp-root.pem is staged into the build context by build.sh and removed by its
// EXIT trap, so it cannot be stat'd/read at doctor time — including it would make
// the digest unreproducible (present at build, absent at check). The digest is
// over the Dockerfile + the source-controlled COPYed files only.
const EXCLUDED_COPY_SOURCES = new Set(["corp-root.pem"]);

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Digest of the agent image's build inputs — the Dockerfile plus the content of
 *  every source-controlled file it COPYs, resolved against `dockerDir`. The COPY
 *  parse mirrors newestBuildInputMtime's old logic exactly: regex `/^\s*COPY\s+(.+)$/i`,
 *  skip `--from=`, strip flags, take every arg except the last (the destination).
 *
 *  Hashes in a STABLE order (sorted relpath) over a canonical
 *  `<relpath>\0<sha256(content)>\n` list, so the byte order the files happen to
 *  appear in the Dockerfile never changes the digest. A COPY source that does not
 *  exist on disk (ENOENT) is skipped deterministically (same choice at build and
 *  check, so the two agree) — corp-root.pem is excluded outright for the same
 *  reason.
 *
 *  Throws if the Dockerfile itself cannot be read, OR if a COPY source that IS on
 *  disk cannot be read (RF-2: a present-at-build but transiently-unreadable source
 *  was hashed into the recorded digest; silently omitting it would shrink the input
 *  set and fabricate a false STALE). docker/ is a required asset dir on any tree
 *  this runs against, so callers treat a throw as "uncomputable" — i.e. NOT stale —
 *  rather than a normal outcome. */
export function computeBuildInputDigest(dockerDir: string): string {
  const dockerfilePath = join(dockerDir, DOCKERFILE);
  const dockerfileBody = readFileSync(dockerfilePath, "utf8");

  const entries: Array<{ rel: string; contentHash: string }> = [
    { rel: DOCKERFILE, contentHash: sha256Hex(Buffer.from(dockerfileBody, "utf8")) },
  ];

  for (const line of dockerfileBody.split("\n")) {
    const m = /^\s*COPY\s+(.+)$/i.exec(line);
    if (!m || /--from=/i.test(m[1]!)) continue;
    const args = m[1]!.trim().split(/\s+/).filter((a) => !a.startsWith("--"));
    for (const src of args.slice(0, -1)) {
      if (EXCLUDED_COPY_SOURCES.has(src)) continue;
      let content: Buffer;
      try {
        content = readFileSync(join(dockerDir, src));
      } catch (e) {
        // A COPY source NOT PRESENT on disk cannot contribute to the digest at
        // build OR check time. Skipping it deterministically is what keeps the two
        // in agreement.
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        // But a source that EXISTS and is merely unreadable here (permission, IO)
        // was present — and hashed — at build time. Omitting it would shrink the
        // input set so the digests differ and report a false STALE (RF-2). The
        // current digest is uncomputable; throw so the caller fails safe to NOT
        // stale rather than computing a partial one.
        throw e;
      }
      entries.push({ rel: src, contentHash: sha256Hex(content) });
    }
  }

  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const canonical = entries.map((e) => `${e.rel}\0${e.contentHash}\n`).join("");
  return sha256Hex(canonical);
}

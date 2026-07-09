// #254: post-task persistence assertion — catch silent work loss.
//
// An agent that writes to an ephemeral container path (the classic case: the
// image's /workspace WORKDIR instead of the /project bind mount — see #254's
// sibling fix in spawn.ts) reports files_modified in result.json while nothing
// lands on the host. The orchestrator gate then sees a green `complete` with a
// file list and advances over an empty diff.
//
// We assert the unambiguous TOTAL-loss signature: a `complete` result that
// claims files_modified but NONE of the claimed paths exist on the host project
// dir. Partial absence is deliberately NOT flagged — it can be a legitimate mix
// of creates and deletes; only the all-absent fingerprint (every claimed file
// missing) is treated as loss. This converts silent discard into a loud,
// diagnosable failure instead of a false `complete`.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type PersistenceCheck =
  | { ok: true }
  | {
      ok: false;
      claimed: string[];
      missing: string[];
      unparseable: string[];
      normalized: Record<string, string | null>;
    };

export type PersistenceCheckDeps = {
  existsFn?: (path: string) => boolean;
  sleepFn?: (ms: number) => Promise<void>;
};

const PROJECT_MOUNT_PREFIX = "/project/";

// FG-377: on macOS, Docker Desktop's gRPC-FUSE / DEC-019 shadow-volume bind
// mount can sync a container's writes to the host a beat after the container
// reports complete. A same-instant total-absence check can catch that gap and
// false-fail, causing the orchestrator to re-run and duplicate/conflict with
// work that actually landed. These bound how long we wait for it to settle.
const SETTLE_RETRIES = 3;
const SETTLE_DELAY_MS = 250;

// FG-491: agent seeds commonly ask for `path:line-range — why` style refs in
// files_modified (the same shape used in PR review comments), not bare paths.
// Treating the whole annotated string as a literal path meant every annotated
// entry resolved to a path that can never exist on disk — so a fully-real,
// fully-persisted result with an all-annotated files_modified list tripped the
// all-claims-missing signature below and got its result discarded. This strips
// the line-spec/prose suffix down to the path token the claim is actually
// about *before* the existence check runs. Annotation text is never treated as
// proof a file exists — a claim that reduces to nothing is unparseable and
// counts as unverifiable, same as a genuinely missing file.
const LINE_SPEC_SUFFIX = /:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;
const TRAILING_PUNCTUATION = /[:,;()]+$/;

// FG-491 (reopened): a bare non-empty first token isn't enough — arbitrary
// prose ("README.md updated the real file elsewhere") has a first token that
// can accidentally name a real file, turning unrelated prose into proof of
// persistence. Only recognize the annotation shapes PR-review-style claims
// actually use: nothing after the token, or an annotation introduced by a
// dash separator (em/en dash or hyphen) or a parenthesized note. Anything
// else after the first token means this isn't a path claim at all.
const ANNOTATION_START = /^[—–-]|^\(/;

export function normalizeClaim(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const spaceIdx = trimmed.search(/\s/);
  const rawToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const remainder = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx).trim();
  if (remainder !== "" && !ANNOTATION_START.test(remainder)) return null;
  let token = rawToken;
  // Loop: stripping a line-spec can expose more trailing punctuation (and
  // vice versa), e.g. "foo.ts:9,90-115," → strip "," → strip ":9,90-115".
  for (let i = 0; i < 4; i++) {
    const next = token.replace(TRAILING_PUNCTUATION, "").replace(LINE_SPEC_SUFFIX, "");
    if (next === token) break;
    token = next;
  }
  return token.length > 0 ? token : null;
}

export async function checkResultPersistence(
  projectDir: string,
  result: unknown,
  deps?: PersistenceCheckDeps,
): Promise<PersistenceCheck> {
  if (!isObject(result)) return { ok: true };
  if (result["status"] !== "complete") return { ok: true };

  const claimed = extractFilesModified(result);
  if (claimed.length === 0) return { ok: true };

  const existsFn = deps?.existsFn ?? existsSync;
  const sleepFn = deps?.sleepFn ?? sleep;

  const normalized: Record<string, string | null> = {};
  for (const raw of claimed) normalized[raw] = normalizeClaim(raw);

  const checkExistence = () =>
    claimed.map((raw) => {
      const n = normalized[raw] ?? null;
      return n !== null && existsOnHost(projectDir, n, existsFn);
    });

  let exists = checkExistence();
  // Only the total-absence signature is loss. If even one claim resolved to a
  // path that landed, persistence is working and any absences are likely
  // intentional deletions (or an annotation that was never a real path claim).
  if (exists.some(Boolean)) return { ok: true };

  for (let attempt = 0; attempt < SETTLE_RETRIES && !exists.some(Boolean); attempt++) {
    await sleepFn(SETTLE_DELAY_MS);
    exists = checkExistence();
  }

  if (exists.some(Boolean)) return { ok: true };

  const missing: string[] = [];
  const unparseable: string[] = [];
  for (const raw of claimed) {
    if (normalized[raw] === null) unparseable.push(raw);
    else missing.push(raw);
  }
  return { ok: false, claimed, missing, unparseable, normalized };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function persistenceErrorMessage(c: {
  claimed: string[];
  missing: string[];
  unparseable?: string[];
  normalized?: Record<string, string | null>;
}): string {
  const n = c.claimed.length;
  const normalizedMap = c.normalized ?? {};
  const sample = c.claimed
    .slice(0, 5)
    .map((raw) => {
      const norm = normalizedMap[raw];
      return norm && norm !== raw ? `${raw} → ${norm}` : raw;
    })
    .join(", ");
  const more = n > 5 ? `, +${n - 5} more` : "";
  const missingSample = c.missing.slice(0, 5).join(", ");
  const missingMore = c.missing.length > 5 ? `, +${c.missing.length - 5} more` : "";
  const unparseable = c.unparseable ?? [];
  const unparseableNote =
    unparseable.length > 0
      ? ` ${unparseable.length} claim(s) had no parseable path token and were treated as unverifiable, ` +
        `never as proof of persistence: ${unparseable.slice(0, 5).join(", ")}` +
        `${unparseable.length > 5 ? `, +${unparseable.length - 5} more` : ""}.`
      : "";
  return (
    `work not persisted: result.json reports status=complete with ${n} modified file(s), ` +
    `but none resolved to an existing path on the host project dir — the agent likely wrote to an ` +
    `ephemeral container path (e.g. /workspace) instead of the /project bind mount, so the diff was ` +
    `discarded on container exit. Claimed (raw → normalized path): ${sample}${more}. ` +
    `Missing on host: ${missingSample}${missingMore}.` +
    unparseableNote +
    ` (If this task intentionally deleted every one of these files, this is a false positive — ` +
    `re-run with the work persisted, or override.)`
  );
}

// Map a normalized claim path to its host location. Returns null when the
// path points outside the project mount (e.g. an absolute /workspace/... path)
// — there is no host equivalent, so it counts as missing.
function resolveHostPath(projectDir: string, normalizedClaim: string): string | null {
  if (!isAbsolute(normalizedClaim)) return join(projectDir, normalizedClaim);
  if (normalizedClaim.startsWith(PROJECT_MOUNT_PREFIX)) {
    return join(projectDir, normalizedClaim.slice(PROJECT_MOUNT_PREFIX.length));
  }
  return null;
}

function existsOnHost(projectDir: string, normalizedClaim: string, existsFn: (path: string) => boolean): boolean {
  const p = resolveHostPath(projectDir, normalizedClaim);
  return p !== null && existsFn(p);
}

function extractFilesModified(result: Record<string, unknown>): string[] {
  const raw = result["files_modified"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is string => typeof f === "string" && f.length > 0);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

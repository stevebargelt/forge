// forge v2 — runtime YAML → docker args translator.
//
// Replaces src/spine/spawn.ts's hardcoded buildDockerArgs with one that reads
// the runtime YAML and substitutes template variables. Same docker invocation
// shape today's spine produces, just declared in YAML instead of code.
//
// Auth modes:
//   - env-snapshot (default for bedrock): host calls `aws configure
//     export-credentials` and injects STS env vars. Implemented in
//     src/util/creds.ts:exportAwsCreds (#121). Reuse it here.
//   - mount: bind-mount ~/.aws into the container. Legacy path; opt-in.
//   - apikey: pass ANTHROPIC_API_KEY env.
//   - oauth-volume: bind-mount the named oauth volume at /home/agent.
//
// The runtime YAML declares which mode applies. The runner picks the right
// substitution context per-step (TASK_ID, MODEL, etc.) and this function
// produces the full `docker run ... claude ...` argv.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Runtime } from "./schema.js";
import { resolveRuntimeMetadata } from "./schema.js";
import {
  exportAwsCreds,
  oauthVolumeName,
  awsConfigDir,
  resolveAwsProfile,
  codexAuthFile,
  piAuthFile,
  apiKeyEnvForProvider,
  knownApiKeyProviders,
} from "../util/creds.js";
import { substitute, substituteOptional, expandTilde, type SubstContext } from "./resolve.js";
import { planDependencyVolumes, provisionerContainerName, type DependencyVolumePlan } from "./dependency-provisioning.js";
import { resolveBacklogStore } from "../backlog/storage-mode.js";
import {
  publishSnapshotOnce,
  registerSnapshotTarget,
  releaseFinishedTargets,
} from "../backlog/snapshot.js";
import { getTicket, recordDispatchEvidence } from "../store/tickets.js";
import { getTask } from "../store/tasks.js";
import { writeTransaction } from "../store/db.js";
import { FORGE_HOME } from "../util/paths.js";

export type SpawnContext = SubstContext & {
  TASK_ID: string;
  TASK_DIR: string;
  PROJECT_DIR: string;
  PROJECT_MODE: "rw" | "ro";
  MODEL: string;
  // #265: the resolved UPSTREAM model vendor (e.g. groq, anthropic, ollama) a
  // multi-provider runtime fronts. Substituted into pi's `--provider` arg. Empty
  // in legacy mode (no policy) → the pi YAML's `${UPSTREAM_PROVIDER:-anthropic}`
  // fallback preserves the anthropic-bound Crawl behavior.
  UPSTREAM_PROVIDER?: string;
  SYSTEM_PROMPT: string;
  // Rendered task-package markdown; piped to the container as stdin per the
  // runtime YAML's `invocation.stdin` field. Mirrors v1 spine's behavior.
  TASK_PACKAGE_MARKDOWN: string;
  // DESIGN_DIR is optional — empty string when --design-dir wasn't passed.
  DESIGN_DIR?: string;
  // Host path to a captured auth-profile storageState file (#176). When set,
  // the file is mounted read-only and BROWSER_TOOLS_STORAGE_STATE points the in-container
  // browser-tools injector at it so the agent operates authenticated without
  // ever seeing the credential. Undefined = no auth profile for this task.
  AUTH_STATE_HOST_PATH?: string;
  // FG-376 FIX1: true only when this dispatch's PROJECT_DIR is a task-scoped
  // git worktree (runNext.ts sets this when a worktree was created for this
  // task). Gates the named lockfile-keyed dependency-volume path so a normal
  // (non-worktree) rw dispatch — which shares the live host project directory
  // across concurrent tasks — keeps its pre-FG-376 legacy single anonymous
  // shadow-volume behavior byte-for-byte. invoke.ts never creates worktrees
  // and never sets this, so `forge invoke` is unaffected.
  // String "1" (not boolean) — SpawnContext extends SubstContext, whose index
  // signature is Record<string, string | undefined>.
  IS_WORKTREE_DISPATCH?: string;
  // FG-376: set by the caller once it has confirmed (host-side, via
  // dependency-provisioning.ts:isDependencyCacheReady / provisionDependencyCache)
  // that this lockfile-hash cache key is populated — "1" mounts the SAME
  // lockfile-keyed volume(s) READ-ONLY for both a worktree-rw primary and a
  // ro reviewer/red dispatch. Installing is exclusively the short-lived
  // provisioner container's job (see buildProvisionerDockerArgs below) — an
  // agent/reviewer container built by buildDockerArgs NEVER installs and
  // NEVER mounts these volumes read-write, regardless of PROJECT_MODE.
  DEPENDENCY_CACHE_MOUNT_RO?: string;
  // FG-621: the CANONICAL project directory — the parent repository a private
  // clone workspace was made from, as FORGE recorded it (the run's projectDir),
  // never anything read out of the workspace. It is what the clone mount planner
  // derives the expected parent object store from, and on the clone substrate it
  // is MANDATORY: without it the planner has nothing Forge-owned to verify the
  // agent-writable `objects/info/alternates` against, so it refuses rather than
  // falling back to shape checks. Optional in the TYPE only because the
  // overwhelmingly common dispatch is not a clone at all, where it is never read.
  // Every production dispatch site sets it; see planWorktreeGitMounts.
  CANONICAL_PROJECT_DIR?: string;
  // FG-608: the backlog ticket this task was built from, when there is one. Used
  // ONLY to record dispatch evidence (revision + body hash) and to inject it into
  // the container so `forge backlog show` can surface a dispatched-vs-current
  // revision difference. Absent for dispatches with no ticket.
  TICKET_ID?: string;
};

// Fixed in-container path for the mounted auth-profile state. A top-level path
// (not under /home/agent) avoids nesting under the oauth-volume mount.
const AUTH_STATE_CONTAINER_PATH = "/forge-auth/state.json";

// FG-608: the in-container backlog authority mount.
//
// A DIRECTORY, not a file, and this is a REQUIREMENT rather than a preference. A
// file bind-mount pins the inode at container start, so the host's atomic
// write-temp + rename (which allocates a NEW inode) would be invisible to the
// container for its entire life — and forge containers are one-per-task,
// long-lived, and never restarted. The only way to make a pinned inode change is
// an in-place rewrite, which is exactly the torn read the concurrency acceptance
// case forbids. Mounting the containing directory `:ro` and renaming INSIDE it is
// the shape that satisfies both. See src/backlog/snapshot.ts.
//
// `:ro` is the ENFORCEMENT primitive, not a hint: agents have passwordless root
// (the image creates `agent` with NOPASSWD:ALL and no --user is ever passed), so a
// CLI-level refusal is trivially bypassed with sudo. The kernel-enforced read-only
// bind is the one thing sudo cannot undo.
//
// A top-level path (not under /home/agent) keeps it OFF the shared oauth volume.
const BACKLOG_SNAPSHOT_CONTAINER_PATH = "/forge-backlog";

/** Host directory holding ONE task's published backlog snapshot. Deliberately NOT
 *  under the task dir: the task dir is bind-mounted READ-WRITE into the container
 *  for result.json, and a snapshot living there would be agent-writable — which
 *  would make the mutation-refusal acceptance case pass vacuously. */
export function backlogSnapshotHostDir(taskId: string): string {
  return join(FORGE_HOME, "backlog-snapshots", taskId);
}

export type BacklogSnapshotMount = {
  hostDir: string;
  containerDir: string;
  projectKey: string;
  dispatchedTicket?: string;
};

/** Prepare this task's live, project-scoped, backlog-only read surface.
 *
 *  Returns undefined — and mounts NOTHING — unless the project has actually cut
 *  over to db mode. A markdown-mode project's tickets are in its own checkout,
 *  which the container already has; mounting an empty snapshot there would be
 *  noise, and mounting one for EVERY dispatch would put a snapshot publication on
 *  the hot path of every project on the host.
 *
 *  Three things happen here, all on the HOST, all before the container starts:
 *    1. publish the first snapshot, so the container's very first read has an
 *       artifact rather than a race with the first host write;
 *    2. REGISTER the target, so every subsequent host ticket write fans out to it
 *       through the production publisher — this is what makes a post-start
 *       amendment visible, and it is deliberately not something a test rigs up;
 *    3. record DISPATCH EVIDENCE (monotonic revision + body hash) for the ticket
 *       this task was built from, so `forge backlog show` in-container can surface
 *       BOTH the dispatched and current revisions when the live ticket advances.
 *
 *  NEVER throws: a snapshot is a derived convenience. A failure here must not
 *  block a dispatch — it degrades to "no mounted authority", which the in-container
 *  reader REFUSES on explicitly rather than silently answering from the wrong store. */
export function prepareBacklogSnapshotMount(
  projectDir: string,
  taskId: string,
  ticketId?: string,
): BacklogSnapshotMount | undefined {
  try {
    const store = resolveBacklogStore(projectDir);
    if (store.mode !== "db") return undefined;
    const hostDir = backlogSnapshotHostDir(taskId);
    // Retire finished tasks' targets first. Without this every ticket write would
    // keep publishing to the snapshot directory of every task this host has ever
    // dispatched for the project — unbounded work per write and unbounded disk.
    // Dispatch is the one moment we are reliably on this project's path, and
    // docker-exec.ts (which owns container teardown) is not ours to change here.
    releaseFinishedTargets(store.projectKey, (id) => {
      const task = getTask(id);
      if (!task) return false; // an unknown task is not live
      return task.status !== "complete" && task.status !== "failed" && task.status !== "blocked_by_red";
    });
    registerSnapshotTarget(store.projectKey, hostDir, taskId);
    publishSnapshotOnce(store.projectKey, hostDir);
    let dispatchedTicket: string | undefined;
    if (ticketId) {
      const row = getTicket(store.projectKey, ticketId);
      if (row && row.bodyHash) {
        dispatchedTicket = `${ticketId}:${row.revision ?? 1}:${row.bodyHash}`;
        writeTransaction(() =>
          recordDispatchEvidence({
            taskId,
            projectKey: store.projectKey,
            ticketId,
            revision: row.revision ?? 1,
            bodyHash: row.bodyHash!,
            dispatchedAt: new Date().toISOString(),
          }),
        );
      }
    }
    return {
      hostDir,
      containerDir: BACKLOG_SNAPSHOT_CONTAINER_PATH,
      projectKey: store.projectKey,
      ...(dispatchedTicket ? { dispatchedTicket } : {}),
    };
  } catch {
    return undefined;
  }
}

// Fixed in-container path for the RO-mounted Codex credential (AWN-7 Walk). The
// entrypoint detects this file and copies it into a writable CODEX_HOME. A
// top-level path (not under /home/agent) keeps it off the oauth-volume mount.
const CODEX_AUTH_CONTAINER_PATH = "/forge-codex-auth/auth.json";
const PI_AUTH_CONTAINER_PATH = "/forge-pi-auth/auth.json";

export type BuildArgsResult = {
  args: string[];
  // stdin payload, if the runtime YAML declared one. Caller pipes it.
  stdin: string | undefined;
  // FG-536: index of the image in `args`. The detached executor
  // (docker-exec.ts) interposes its entry script immediately after the image
  // without re-deriving docker's [OPTIONS] IMAGE [COMMAND] boundary from flag
  // knowledge it doesn't have.
  imageIndex: number;
};

// FG-497: Linux caps a single argv/env string at MAX_ARG_STRLEN (131072 bytes,
// include/uapi/linux/binfmts.h). A composed prompt or env value that breaches
// this makes the container's exec() die with E2BIG before the agent starts —
// no result.json, no stdout, just a bare exit. Guard well under the real limit
// so an oversized embed fails loud on the host with a diagnostic instead of
// surfacing as an unexplained container crash.
const MAX_SINGLE_ARG_BYTES = 120_000;

function assertWithinArgLimit(label: string, value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_SINGLE_ARG_BYTES) {
    throw new Error(
      `FG-497: ${label} is ${bytes} bytes, exceeding MAX_SINGLE_ARG_BYTES (${MAX_SINGLE_ARG_BYTES}) — ` +
        `a single argv/env string this large risks E2BIG at container exec (Linux MAX_ARG_STRLEN is 131072 bytes). ` +
        `Move this content onto stdin instead of argv/env.`,
    );
  }
}

// FG-559: the sentinel the container entrypoint exits with when git does not
// resolve inside the project mount (docker/agent-entrypoint.sh — the two MUST
// match). Peer of DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE (123); the runner
// classifies both as verification_environment_unavailable rather than letting
// them fall into the generic container_crash branch. Not 124 — that is
// timeout(1)'s conventional code and would be ambiguous in a wrapped exec.
export const GIT_UNAVAILABLE_EXIT_CODE = 122;

// The absolute path a `.git` POINTER FILE names, or undefined when `.git` is a
// real directory / absent. What the pointer names is NOT trusted — see
// resolveVerifiedCommonGitDir.
function readGitdirPointer(projectDir: string): string | undefined {
  const dotGit = join(projectDir, ".git");
  const st = statSync(dotGit, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return undefined;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
  if (!m) return undefined;
  return resolve(projectDir, m[1]!.trim());
}

function isUnder(child: string, ancestor: string): boolean {
  return child.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep);
}

/** FG-559: host absolute paths that must be bind-mounted AT THEIR OWN PATH for
 *  a linked worktree's git to resolve inside the container; [] for a plain
 *  clone or a non-git dir.
 *
 *  A linked worktree's `.git` is a FILE holding `gitdir: <absolute path>` into
 *  the PARENT repo's `.git`, which forge does not otherwise mount — so every
 *  git command in the container fails and the agent silently works from the
 *  file tree. Resolution is TWO hops and both must land on mounted storage: the
 *  absolute hop into the worktree admin dir, then the RELATIVE `commondir` hop
 *  (`../..`) into the common `.git`. Mounting the admin dir alone is verified
 *  insufficient — hence resolving commondir here rather than assuming.
 *
 *  Mounting at the host path is what makes this work with ZERO env vars:
 *  GIT_DIR/GIT_WORK_TREE are global to the container process tree and make
 *  unrelated repos report the worktree's status (a silent wrong answer, which
 *  is worse than the loud failure they'd replace).
 *
 *  FG-621: the name is now narrower than the job. This also plans the PRIVATE
 *  CLONE substrate, whose `.git` is a real DIRECTORY and whose borrowed object
 *  store dangles in the container for the same reason a worktree's `gitdir:`
 *  pointer did — see planGitMounts below for the substrate split. The linked
 *  worktree behavior above is unchanged, and `canonicalProjectDir` is only ever
 *  consulted on the clone path — where it is REQUIRED, not optional: a borrowed
 *  object store with no Forge-owned parent to check it against is refused. */
export function planWorktreeGitMounts(projectDir: string, canonicalProjectDir?: string): string[] {
  return planGitMounts(projectDir, canonicalProjectDir).paths;
}

/** FG-621: which SUBSTRATE `projectDir` is, and the host paths that substrate
 *  needs bound for git to resolve inside the container.
 *
 *   - "worktree" — FG-559's linked worktree (`.git` is a `gitdir:` POINTER FILE).
 *     Needs the parent's whole common `.git`, read-only. Unchanged by FG-621:
 *     this is the non-mutating/red substrate and it stays exactly as shipped.
 *   - "clone" — FG-621's private writable clone (`.git` is a DIRECTORY carrying
 *     `objects/info/alternates`). Needs the parent's OBJECT STORE ALONE,
 *     read-only — never the parent `.git`. That narrowness is the boundary: the
 *     parent's refs, index, HEAD and packed-refs are then ABSENT from the
 *     container rather than merely unwritable, so ref creation and
 *     `main`/`origin/*`/packed-ref updates are refused by absence, and
 *     object-store deletion by the kernel-enforced `:ro` bind.
 *   - "none" — an ordinary checkout, a plain (non-shared) clone, or a non-git
 *     directory: `.git` rides along inside the /project mount, no extra bind.
 */
type GitMountPlan = { kind: "worktree" | "clone" | "none"; paths: string[] };

function planGitMounts(projectDir: string, canonicalProjectDir?: string): GitMountPlan {
  const gitdir = readGitdirPointer(projectDir);
  if (gitdir) {
    // The admin dir lives INSIDE the common .git, so the single common-dir mount
    // covers both hops.
    return { kind: "worktree", paths: [resolveVerifiedCommonGitDir(projectDir, gitdir)] };
  }
  const dotGit = join(projectDir, ".git");
  if (!statSync(dotGit, { throwIfNoEntry: false })?.isDirectory()) return { kind: "none", paths: [] };
  const objects = planSharedCloneObjectStoreMount(projectDir, dotGit, canonicalProjectDir);
  return objects.length > 0 ? { kind: "clone", paths: objects } : { kind: "none", paths: [] };
}

/** FG-621: the object stores a `git clone --shared` workspace borrows — the whole
 *  chain, nearest first — or [] when `projectDir` is an ordinary self-contained
 *  repo.
 *
 *  DERIVE, THEN VERIFY — never trust-then-bind. `objects/info/alternates` lives
 *  INSIDE the rw-mounted workspace, so it is strictly MORE agent-writable than
 *  the `gitdir:` pointer resolveVerifiedCommonGitDir already refuses to trust.
 *  It is therefore never treated as an instruction to mount a path; it is a
 *  VALUE that has to survive proof:
 *
 *    1. shape — exactly one entry, absolute, resolving to a real directory that
 *       is really the `objects` dir of a real git dir (the same HEAD/objects/refs
 *       marker triple resolveVerifiedCommonGitDir requires), and never the
 *       clone's own object store: no repository is ever its own alternate;
 *    2. IDENTITY, MANDATORY — the resolved path must be one of the object stores
 *       the caller's Forge-owned canonical project directory ITSELF reaches
 *       (canonicalObjectStores), realpath-normalized. This is the only proof that
 *       says "this project's parent" rather than "some git repository", and it is
 *       exactly what the shape checks cannot say: an agent that repoints its own
 *       alternates at any other repo on the host passes every one of them. So a
 *       missing canonical dir is a REFUSAL, never a skip and never a fallback to
 *       (1) and (3) — a verification that silently does not run is not a
 *       verification, which is how this defect stayed invisible;
 *    3. base-commit containment — the resolved store must actually hold this
 *       workspace's checked-out commit. The mount plan is built BEFORE the
 *       container starts, against a create-only clone whose HEAD is the recorded
 *       base SHA, so HEAD is by construction an object the PARENT owns. Kept as
 *       a second, independent binding of the value to THIS clone; it does not
 *       substitute for (2), because a sibling task's clone of the same parent
 *       holds the same base commit;
 *    4. the WHOLE CHAIN, not one hop. A parent that itself borrows (a project dir
 *       cloned with `--shared` / `--reference`) serves part of its history from a
 *       store one hop further out, and mounting only the first hop hands the
 *       container an object graph that is still incomplete — the FG-559
 *       history-blind failure in a new place, and the one outcome that is not
 *       acceptable. Each further hop is proved the same way (1) is, must be
 *       ABSOLUTE (a relative entry resolves against the mounted path, which the
 *       container reaches through a bind rather than the host's symlinks, so it
 *       can name a different directory inside than out), and is bounded by
 *       MAX_ALTERNATE_HOPS with a cycle guard.
 *
 *  Every failure REFUSES. Never a warn, never a fallback to []: a silent [] here
 *  is the FG-559 defect twin — a container whose object store is broken, whose
 *  `git log` and `git commit` both fail, and whose agent then works from the file
 *  tree and reports success. */
function planSharedCloneObjectStoreMount(
  projectDir: string,
  gitDir: string,
  canonicalProjectDir?: string,
): string[] {
  const objectsDir = join(gitDir, "objects");
  const alternatesFile = join(objectsDir, "info", "alternates");
  // Explicitly typed so TypeScript treats every call as never-returning: the
  // proofs below narrow through it rather than re-testing what it already refused.
  const refuse: (why: string) => never = (why) => {
    throw new Error(
      `FG-621: ${projectDir} is a git repository whose object store ${why}. Forge bind-mounts ONLY ` +
        `the parent repository's own object store — read-only, at its own host path — into agent ` +
        `containers; refusing to mount an unverified host path.`,
    );
  };

  const entry = soleAlternateEntry(objectsDir, refuse);
  if (entry === undefined) {
    // No alternates: an ordinary checkout or a plain clone, which needs no extra
    // bind (FG-559 behavior, unchanged — this is the overwhelmingly common
    // dispatch and it costs one stat). The one exception is a borrowing clone
    // whose alternates file was DELETED: its own object store owns nothing, yet
    // HEAD still resolves, so it cannot serve its own history to anyone. That is
    // an unverifiable state, not an ordinary repo — refuse it rather than
    // dispatch a container that is history-blind by construction.
    if (objectStoreOwnsNoObjects(objectsDir) && gitRun(["-C", projectDir, "rev-parse", "--verify", "--quiet", "HEAD"]).code === 0) {
      refuse(
        `owns no objects and has no ${alternatesFile}, yet HEAD resolves — a borrowed (\`clone --shared\`) ` +
          `object store whose alternates file is missing or was removed`,
      );
    }
    return [];
  }
  const parent = provenAlternateStore(entry, alternatesFile, refuse);
  if (existsSync(objectsDir) && parent.resolved === realpathSync(objectsDir)) {
    refuse(`names its OWN object store ${parent.resolved} in ${alternatesFile} — no repository is ever its own alternate`);
  }

  if (canonicalProjectDir === undefined) {
    refuse(
      `is borrowed from ${parent.resolved}, but no Forge-owned canonical project directory was supplied to derive the ` +
        `expected parent object store from. ${alternatesFile} lives inside the workspace forge mounts READ-WRITE, ` +
        `so it is agent-controlled: it can name any git repository on this host and satisfy every shape check. ` +
        `Only a derive-and-compare against Forge's own record of the parent proves it is THIS project's`,
    );
  }
  const expected = canonicalObjectStores(canonicalProjectDir);
  if (expected.length === 0) {
    refuse(
      `is borrowed, but the canonical project directory ${canonicalProjectDir} has no resolvable object ` +
        `store to verify ${parent.resolved} against`,
    );
  }
  if (!expected.includes(parent.resolved)) {
    refuse(
      `names ${parent.resolved} in ${alternatesFile}, which is NOT an object store of the canonical project ` +
        `directory ${canonicalProjectDir} (${expected.join(", ")})`,
    );
  }

  const head = gitRun(["-C", projectDir, "rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) {
    refuse(
      `is borrowed from ${parent.resolved}, but this workspace's HEAD does not resolve, so there is no base commit ` +
        `to prove that borrow against`,
    );
  }
  if (gitRun(["--git-dir", parent.gitDir, "cat-file", "-e", `${head.stdout}^{commit}`]).code !== 0) {
    refuse(
      `names ${parent.resolved} in ${alternatesFile}, which does not contain this workspace's checked-out commit ` +
        `${head.stdout} — it is not the parent repository this clone was made from`,
    );
  }

  // Proof (4): the parent may borrow too. Follow the chain to its end, holding
  // every hop to the same shape proof soleAlternateEntry applies to the first —
  // absolute entries included, which matters MORE here: a deeper hop is resolved
  // by git INSIDE the container, against a bind mount rather than this host's
  // symlinks, so a relative entry can name a different directory there than here.
  // Mounting hop 1 alone would leave `git log` blind to whatever the grandparent
  // owns, and an object graph the agent cannot see whole is not a graph.
  const mounts = [parent.named];
  const seen = new Set([parent.resolved]);
  let cursor = parent;
  for (let hop = 2; ; hop++) {
    const file = join(cursor.resolved, "info", "alternates");
    const next = soleAlternateEntry(cursor.resolved, refuse);
    if (next === undefined) break;
    if (hop > MAX_ALTERNATE_HOPS) {
      refuse(
        `is borrowed through a chain of more than ${MAX_ALTERNATE_HOPS} object stores (via ${file}) — ` +
          `forge mounts the chain it can prove, and refuses rather than truncate one`,
      );
    }
    const store = provenAlternateStore(next, file, refuse);
    if (seen.has(store.resolved)) {
      refuse(`is borrowed through a CYCLE of alternate object stores, revisiting ${store.resolved} via ${file}`);
    }
    seen.add(store.resolved);
    mounts.push(store.named);
    cursor = store;
  }
  return mounts;
}

/** How far the alternates chain may run before forge refuses it outright. Any
 *  real `--shared`/`--reference` topology is one or two hops; the bound exists so
 *  a pathological chain fails loudly instead of being silently truncated into an
 *  incomplete object graph. */
const MAX_ALTERNATE_HOPS = 8;

/** The ONE alternate object store an `objects` dir names, verbatim — undefined
 *  when it has no `objects/info/alternates` at all. Every shape forge does not
 *  write is refused rather than interpreted. Shared by the workspace's own hop and
 *  by each further hop of the parent chain, so a borrowing parent is held to
 *  exactly the standard the workspace is. */
function soleAlternateEntry(objectsDir: string, refuse: (why: string) => never): string | undefined {
  const file = join(objectsDir, "info", "alternates");
  const st = statSync(file, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (!st.isFile()) return refuse(`has an ${file} that is not a regular file`);

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    return refuse(`has an unreadable ${file} (${(e as Error).message})`);
  }
  // git's own format: one object store per line; `#` comments and blank lines
  // are ignored. A quoted entry is legal git but not a shape forge writes.
  const entries = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  if (entries.length === 0) return refuse(`has an empty ${file}`);
  if (entries.length > 1) {
    return refuse(
      `names ${entries.length} alternate object stores (${entries.join(", ")}) in ${file} — ` +
        `a forge private clone borrows exactly ONE, its parent's`,
    );
  }
  const entry = entries[0]!;
  if (entry.startsWith('"')) return refuse(`names a quoted alternate (${entry}) in ${file}`);
  if (!isAbsolute(entry)) {
    return refuse(
      `names a RELATIVE alternate (${entry}) in ${file} — the mount is an identity bind of an ` +
        `ABSOLUTE host path, and a relative entry resolves against a different tree inside the container`,
    );
  }
  return entry;
}

/** Prove one alternates entry really is the object store of a real git dir, and
 *  return the paths that matter.
 *
 *  Two of them, deliberately: `named` is the string the CONTAINER will look up
 *  (git re-reads the same alternates file inside the container, so the bind has to
 *  land at exactly the path it names — resolving symlinks for the mount would
 *  silently dangle the entry again, which is the FG-559 failure mode). `resolved`
 *  is what every PROOF runs against, so a symlink cannot be used to dress one
 *  directory up as another. */
function provenAlternateStore(
  entry: string,
  file: string,
  refuse: (why: string) => never,
): { named: string; resolved: string; gitDir: string } {
  const named = resolve(entry);
  let resolved: string;
  try {
    resolved = realpathSync(named);
  } catch {
    return refuse(`names ${entry} in ${file}, which does not exist on this host`);
  }
  if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    return refuse(`names ${entry} in ${file}, which is not a directory`);
  }
  if (basename(resolved) !== "objects") {
    return refuse(`names ${resolved} in ${file}, which is not a git \`objects\` directory`);
  }
  const gitDir = dirname(resolved);
  for (const marker of ["HEAD", "objects", "refs"]) {
    if (!existsSync(join(gitDir, marker))) {
      return refuse(`names ${resolved} in ${file}, whose repository ${gitDir} has no ${marker}`);
    }
  }
  return { named, resolved, gitDir };
}

/** FG-621: every object store the Forge-owned canonical project directory itself
 *  reaches — the one its repository owns, plus the ones that repository borrows,
 *  transitively. Empty only when git cannot answer at all, which the caller
 *  REFUSES on.
 *
 *  DERIVED THROUGH GIT, never by assuming a layout. `<dir>/.git/objects` is merely
 *  the shape of an ORDINARY checkout: when the run's projectDir is ITSELF a linked
 *  worktree its `.git` is a `gitdir:` POINTER FILE and that path does not exist at
 *  all, so the layout assumption turned the (correct, mandatory) identity check
 *  into a hard refusal of EVERY mutating dispatch in that configuration.
 *  `rev-parse --git-path objects` answers for a checkout, a linked worktree and a
 *  bare repo alike.
 *
 *  A SET rather than one path, for the same reason the mount plan follows the
 *  chain: a project dir cloned with `--shared`/`--reference` serves part of its
 *  own history from a store one hop further out, so a workspace naming that store
 *  is naming something THIS project genuinely reaches. Membership is no weaker
 *  than equality was — every member is derived from the canonical dir's own git
 *  configuration, which is Forge-owned state, never from the agent-writable
 *  workspace — and where the canonical dir borrows nothing the set is exactly the
 *  single path it always was. */
function canonicalObjectStores(canonicalProjectDir: string): string[] {
  const probe = gitRun(["-C", canonicalProjectDir, "rev-parse", "--git-path", "objects"]);
  if (probe.code !== 0 || probe.stdout.length === 0) return [];
  let own: string;
  try {
    own = realpathSync(resolve(canonicalProjectDir, probe.stdout));
  } catch {
    return [];
  }

  const stores: string[] = [];
  const queue = [own];
  const seen = new Set(queue);
  while (queue.length > 0 && stores.length < MAX_ALTERNATE_HOPS) {
    const store = queue.shift()!;
    stores.push(store);
    let raw: string;
    try {
      raw = readFileSync(join(store, "info", "alternates"), "utf8");
    } catch {
      continue; // no alternates, or unreadable — either way this store borrows nothing we can name
    }
    for (const line of raw.split("\n")) {
      const entry = line.trim();
      if (entry.length === 0 || entry.startsWith("#")) continue;
      let rp: string;
      try {
        // git resolves a relative alternate against the object store holding the
        // file — this list is only ever compared against, never mounted, so a
        // relative entry is resolvable here where it would not be bindable.
        rp = realpathSync(resolve(store, entry));
      } catch {
        continue;
      }
      if (seen.has(rp)) continue;
      seen.add(rp);
      queue.push(rp);
    }
  }
  return stores;
}

/** True when this object store contains no objects of its own — no loose fanout
 *  directory and no packfile. A `git clone --shared` starts exactly this way (it
 *  borrows everything); an ordinary repo with any history does not. Pure
 *  filesystem, so the common dispatch never pays for a git subprocess. */
function objectStoreOwnsNoObjects(objectsDir: string): boolean {
  let entries;
  try {
    entries = readdirSync(objectsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name === "info") continue;
    if (e.name === "pack") {
      try {
        if (readdirSync(join(objectsDir, "pack")).some((n) => n.endsWith(".pack"))) return false;
      } catch {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

/** FG-621: git, host-side, for the clone-substrate proofs only. Reached solely on
 *  the borrowed-object-store path — never on an ordinary dispatch.
 *
 *  The git-plumbing env vars are STRIPPED, not inherited. `GIT_OBJECT_DIRECTORY`
 *  in particular would redirect the containment proof's object lookup away from
 *  the store being verified and turn it into a rubber stamp; `GIT_DIR` /
 *  `GIT_WORK_TREE` / `GIT_COMMON_DIR` would answer the HEAD question about some
 *  other repository. A proof that an ambient variable can steer is not a proof. */
function gitRun(args: string[]): { code: number; stdout: string } {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
  ]) {
    delete env[key];
  }
  const r = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  return { code: r.status ?? -1, stdout: (r.stdout ?? "").trim() };
}

/** FG-559: the `gitdir:` line lives in the PROJECT TREE, which a project — or a
 *  prior writable agent — can rewrite to name any host path. Bind-mounting
 *  whatever it says would hand every later container arbitrary host data at its
 *  own path, so accept only the shape `git worktree add` writes and refuse
 *  everything else: an admin dir `<common>/worktrees/<name>` carrying git's own
 *  `commondir` + `gitdir` files, whose `commondir` resolves back to that same
 *  grandparent, and whose common dir is really a git dir. Returns the common
 *  dir — the one path that must be mounted. */
function resolveVerifiedCommonGitDir(projectDir: string, adminDir: string): string {
  const commonDir = dirname(dirname(adminDir));
  const refuse = (why: string): never => {
    throw new Error(
      `FG-559: ${projectDir}/.git is a gitdir: pointer to ${adminDir}, which ${why}. Only a linked ` +
        `worktree's admin dir (<repo>/.git/worktrees/<name>) is bind-mounted into agent containers; ` +
        `refusing to mount an unverified host path.`
    );
  };
  if (!statSync(adminDir, { throwIfNoEntry: false })?.isDirectory()) refuse("is not a directory");
  if (basename(dirname(adminDir)) !== "worktrees") refuse("does not sit under a worktrees/ parent");
  if (!existsSync(join(adminDir, "gitdir"))) refuse("has no gitdir back-pointer file");
  const commondirFile = join(adminDir, "commondir");
  if (!existsSync(commondirFile)) refuse("has no commondir file");
  if (resolve(adminDir, readFileSync(commondirFile, "utf8").trim()) !== commonDir) {
    refuse(`has a commondir that does not resolve to its own parent repo (${commonDir})`);
  }
  for (const marker of ["HEAD", "objects", "refs"]) {
    if (!existsSync(join(commonDir, marker))) refuse(`resolves to ${commonDir}, which has no ${marker}`);
  }
  return commonDir;
}

/** FG-559 piece A — the mount-plan assertion. The host CANNOT detect this by
 *  resolving the path: host-side the `gitdir:` target resolves perfectly, which
 *  is exactly why the defect stayed silent. The question is about the argv being
 *  built — "`PROJECT_DIR/.git` points OUTSIDE `PROJECT_DIR`; is that path in the
 *  mount list I am about to hand docker?"
 *
 *  Refuses rather than warns, and unconditionally: the predicate has no
 *  false-positive class. A non-git project has no `.git`; a plain clone has a
 *  `.git` directory; a correctly-mounted worktree passes. It can only fire on
 *  the exact broken state.
 *
 *  FG-621 widens WHAT it covers, not how it behaves: on the private-clone
 *  substrate the required path is the parent's object store rather than the
 *  parent's common `.git`, and the same "is that path in the argv I am about to
 *  hand docker?" question is asked of it. Before FG-621 this assertion was
 *  vacuous on a clone — the planner returned [] for it, so nothing was required
 *  and nothing was checked. */
export function assertWorktreeGitMountPlanned(
  projectDir: string,
  args: string[],
  canonicalProjectDir?: string,
): void {
  const plan = planGitMounts(projectDir, canonicalProjectDir);
  const missing = plan.paths.filter((p) => !isIdentityMountPlanned(p, args));
  if (missing.length === 0) return;
  if (plan.kind === "clone") {
    throw new Error(
      `FG-621: ${projectDir} is a private clone borrowing the object store ${missing.join(", ")}, which ` +
        `the docker mount plan does not bind READ-ONLY at its own host path. Inside the container the ` +
        `alternates entry would dangle, so \`git log\` and \`git commit\` would both fail and the agent ` +
        `would work history-blind. Refusing to dispatch.`,
    );
  }
  throw new Error(
    `FG-559: ${projectDir}/.git is a gitdir: pointer into ${missing.join(", ")}, which the docker ` +
      `mount plan does not bind at its own host path. Every git command inside the container would ` +
      `fail with "fatal: not a git repository" and the agent would work history-blind. Refusing to dispatch.`,
  );
}

// True when argv already binds `hostPath` (or an ancestor of it) to the SAME
// path inside the container. Identity is the point: the `gitdir:` line is an
// absolute HOST path, so only a host-path-preserving bind makes it resolve.
function isIdentityMountPlanned(hostPath: string, args: string[]): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-v") continue;
    const [host, container] = args[i + 1]!.split(":");
    if (!host || host !== container) continue;
    if (hostPath === host || isUnder(hostPath, host)) return true;
  }
  return false;
}

export function buildDockerArgs(runtime: Runtime, ctx: SpawnContext): BuildArgsResult {
  // FG-492: deliberately NO --rm for a task/reviewer agent container. Capturing
  // causal evidence (docker inspect: exit code, signal, OOMKilled, State.Error)
  // requires the container still exist after its process exits — --rm races
  // the daemon's own removal against docker-exec.ts's capture-at-close read.
  // docker-exec.ts (the shared executor) now owns the reap/retain decision
  // instead: it removes a clean exit immediately and retains a failed one
  // (FORGE_CONTAINER_RETENTION=off disables retention entirely). The
  // short-lived dependency provisioner below (buildProvisionerDockerArgs) is
  // NOT in scope for this — it's a different, always-short-lived container and
  // keeps its own --rm.
  const args: string[] = ["run", "-i"];

  // --name
  args.push("--name", substitute(runtime.container.name, ctx));

  // Auth → env / mounts. FORGE_AUTH_MODE=mount override sidesteps env-snapshot
  // when the user wants the legacy behavior.
  const effectiveAuth =
    process.env.FORGE_AUTH_MODE === "mount" && runtime.auth.mode === "env-snapshot"
      ? "mount"
      : runtime.auth.mode;

  switch (effectiveAuth) {
    case "env-snapshot": {
      // STS env vars from host.
      const creds = exportAwsCreds(resolveAwsProfile());
      args.push("-e", `AWS_ACCESS_KEY_ID=${creds.AWS_ACCESS_KEY_ID}`);
      args.push("-e", `AWS_SECRET_ACCESS_KEY=${creds.AWS_SECRET_ACCESS_KEY}`);
      args.push("-e", `AWS_SESSION_TOKEN=${creds.AWS_SESSION_TOKEN}`);
      break;
    }
    case "mount": {
      args.push("-e", `AWS_PROFILE=${resolveAwsProfile()}`);
      args.push("-v", `${awsConfigDir()}:/home/agent/.aws:ro`);
      break;
    }
    case "apikey": {
      // #303: inject the RESOLVED upstream provider's API key, not always
      // ANTHROPIC_API_KEY. Empty UPSTREAM_PROVIDER (legacy / no-policy invoke)
      // → anthropic, so existing pi-apikey and claude-apikey behavior is
      // unchanged. The env-var map is shared with provider-doctor so a key the
      // doctor reports available is the same one injected here.
      const provider = ctx.UPSTREAM_PROVIDER || "anthropic";
      const envVar = apiKeyEnvForProvider(provider);
      if (!envVar) {
        throw new Error(
          `auth.mode=apikey: no API-key binding for upstream provider '${provider}' ` +
            `(known: ${knownApiKeyProviders().join(", ")})`,
        );
      }
      const key = process.env[envVar];
      if (!key) throw new Error(`auth.mode=apikey but ${envVar} env is unset (upstream provider '${provider}')`);
      args.push("-e", `${envVar}=${key}`);
      break;
    }
    case "oauth-volume": {
      args.push("-v", `${oauthVolumeName()}:/home/agent`);
      break;
    }
    case "codex-auth": {
      // AWN-7 Walk: RO-mount ONLY the Codex subscription credential file (never
      // the whole ~/.codex dir). Fail loud if it's absent — bind-mounting a
      // missing source would make docker create a phantom dir at the host path.
      // The entrypoint copies it into a writable CODEX_HOME for token refresh.
      const authFile = codexAuthFile();
      if (!existsSync(authFile)) {
        throw new Error(
          `auth.mode=codex-auth but ${authFile} is missing — run \`codex login\` on the host`,
        );
      }
      args.push("-v", `${authFile}:${CODEX_AUTH_CONTAINER_PATH}:ro`);
      break;
    }
    case "pi-auth": {
      // #266: RO-mount ONLY pi's OAuth credential (forge-managed, minted by
      // `forge pi login`). Fail loud if absent — a missing bind source would make
      // docker create a phantom dir. The entrypoint copies it into a writable
      // PI_CODING_AGENT_DIR so in-container token refresh works.
      const authFile = piAuthFile();
      if (!existsSync(authFile)) {
        throw new Error(
          `auth.mode=pi-auth but ${authFile} is missing — run \`forge pi login\` once to authenticate pi (OAuth).`,
        );
      }
      args.push("-v", `${authFile}:${PI_AUTH_CONTAINER_PATH}:ro`);
      break;
    }
  }

  // Static env from runtime.env, with substitution.
  for (const [k, v] of Object.entries(runtime.env)) {
    args.push("-e", `${k}=${substitute(v, ctx)}`);
  }

  // Mounts.
  let browserToolsHostPath: string | undefined;
  // Container path the project bind mount lands at (e.g. /project). Captured so
  // we can set it as the working directory below — the image's WORKDIR is the
  // ephemeral /workspace, so without an explicit -w any cwd-relative write
  // (scaffolders: `pnpm create`, `npm init`, generated node_modules/dist) lands
  // in a non-persisted path and is silently discarded on container removal.
  // Identified by the mount whose host template is the project dir.
  let projectContainerPath: string | undefined;
  let projectMode: string | undefined;
  for (const mount of runtime.mounts) {
    if (mount.host === "${PROJECT_DIR}") projectContainerPath = mount.container;
    const hostResolved = mount.optional
      ? substituteOptional(mount.host, ctx)
      : substitute(mount.host, ctx);

    // A skipped optional *skill* mount (e.g. browser-tools) silently strips a
    // capability the agent seeds assume — visual verification above all — which
    // surfaces downstream as a confusing "no browser" report. Warn so it's
    // diagnosable rather than invisible.
    const warnIfSkill = (reason: string): void => {
      if (!mount.container.includes("/.claude/skills/")) return;
      const skill = mount.container.split("/").pop() ?? "skill";
      const extra = skill === "browser-tools" ? " — no browser-tools means no visual UI verification" : "";
      console.error(
        `forge: WARNING — skill mount '${skill}' skipped (${reason})${extra}. ` +
          `Set FORGE_BROWSER_TOOLS_DIR or create the host path so agents can verify.`,
      );
    };

    if (hostResolved === undefined) {
      warnIfSkill(`host '${mount.host}' unresolved`);
      continue; // optional + unresolved
    }
    const hostPath = expandTilde(hostResolved);

    if (mount.optional && !existsSync(hostPath)) {
      warnIfSkill(`host '${hostPath}' not found`);
      continue;
    }

    const mode = substitute(mount.mode, ctx);
    if (mount.host === "${PROJECT_DIR}") projectMode = mode;
    args.push("-v", `${hostPath}:${mount.container}:${mode}`);
    if (mount.container.includes("/skills/browser-tools")) browserToolsHostPath = hostPath;
  }

  // #176 auth profile: mount the captured session read-only and point the
  // browser-tools injector at it via BROWSER_TOOLS_STORAGE_STATE (a generic
  // browser-tools env var, not forge-branded — #182). The token never enters
  // argv / prompts / logs — only this single read-only file, never the project
  // mount. The injector lives in the browser-tools skill, so a skipped skill
  // mount would silently no-op auth; fail fast instead.
  if (ctx.AUTH_STATE_HOST_PATH) {
    if (!browserToolsHostPath) {
      throw new Error(
        "--auth-profile needs the browser-tools skill (it carries the auth injector), " +
          "but that mount was skipped. Set FORGE_BROWSER_TOOLS_DIR or create the host path.",
      );
    }
    // #181 pin: the mount existing isn't enough — an old/upstream browser-tools
    // checkout has no injector, so auth would silently no-op. Require the
    // injector file. Pinned dependency: pi-skills fork branch
    // feat/preload-storage-state (github.com/stevebargelt/pi-skills, >= cac695b).
    if (!existsSync(join(browserToolsHostPath, "auth-inject.js"))) {
      throw new Error(
        `--auth-profile requires the browser-tools auth injector, but ${browserToolsHostPath}/auth-inject.js ` +
          "is missing. Point FORGE_BROWSER_TOOLS_DIR at a pi-skills checkout on the " +
          "feat/preload-storage-state branch (github.com/stevebargelt/pi-skills, >= cac695b).",
      );
    }
    args.push("-v", `${ctx.AUTH_STATE_HOST_PATH}:${AUTH_STATE_CONTAINER_PATH}:ro`);
    args.push("-e", `BROWSER_TOOLS_STORAGE_STATE=${AUTH_STATE_CONTAINER_PATH}`);
  }

  // #245/FG-376: shadow the project's node_modules with container-local named
  // volumes on macOS rw mounts (supersedes FORGE-DEC-011). Docker Desktop's
  // grpcfuse stamps a `com.docker.grpcfuse.ownership` xattr on native binaries
  // the container writes (e.g. better-sqlite3.node); CyberArk-class EDR then
  // silently SIGKILLs the HOST node processes that load them. The volumes keep
  // every node_modules write inside the container (never written back through
  // grpcfuse) AND hide the host's wrong-platform (macOS-arm64) modules so the
  // agent gets correct linux ones instead of hand-patching. Scoped to:
  //   - darwin only: Linux hosts have no grpcfuse and matching-arch modules.
  //   - escape hatch FORGE_NO_NM_SHADOW=1 to disable without a code change.
  //
  // FG-376: one NAMED volume per workspace member (repo root + every npm
  // `workspaces` entry), keyed by a hash of package-lock.json, instead of a
  // single anonymous volume — so a task with an unchanged lockfile reuses an
  // already-populated volume instead of reinstalling (e.g. the Shipping
  // Reviewer reusing the engineer's install, FG-372). A project with no
  // package-lock.json (non-npm project, bare test fixture) falls back to the
  // original anonymous single-volume shadow — still correct, just not reusable.
  //
  // buildDockerArgs builds AGENT/reviewer containers ONLY — it never installs
  // and never mounts a named dependency volume read-write. Installing is
  // exclusively buildProvisionerDockerArgs's short-lived container's job
  // (below); by the time this function runs, the caller (runNext.ts) has
  // already confirmed the cache key is populated and sets
  // DEPENDENCY_CACHE_MOUNT_RO accordingly. FORGE_NM_INSTALL_ROOT is never
  // emitted here — an agent/reviewer container has no reason to write into
  // the shared cache, ever.
  if (
    projectContainerPath &&
    process.platform === "darwin" &&
    process.env.FORGE_NO_NM_SHADOW !== "1"
  ) {
    const legacyShadowPath = `${projectContainerPath}/node_modules`;

    if (projectMode === "rw" && ctx.IS_WORKTREE_DISPATCH === "1" && ctx.DEPENDENCY_CACHE_MOUNT_RO === "1") {
      // Worktree-mode primary, cache already provisioned host-side (the
      // caller never sets DEPENDENCY_CACHE_MOUNT_RO otherwise) — mount the
      // named lockfile-keyed volumes READ-ONLY, same as a reviewer below.
      let plan;
      try {
        plan = planDependencyVolumes(ctx.PROJECT_DIR, projectContainerPath);
      } catch {
        plan = undefined;
      }
      if (plan) {
        for (const v of plan.volumes) {
          args.push("-v", `${v.name}:${v.containerPath}:ro`);
        }
        // Diagnostic env only (no chown/install trigger here — the
        // provisioner already chowned + installed these volumes). Kept for
        // parity with the legacy single-path var and for `forge show`/manifest
        // visibility into which cache key this dispatch used.
        args.push("-e", `FORGE_NM_SHADOW=${legacyShadowPath}`);
        args.push("-e", `FORGE_NM_SHADOW_PATHS=${plan.volumes.map((v) => v.containerPath).join(":")}`);
        args.push("-e", `FORGE_NM_LOCKFILE_HASH=${plan.lockfileHash}`);
      } else {
        args.push("-v", legacyShadowPath);
        args.push("-e", `FORGE_NM_SHADOW=${legacyShadowPath}`);
      }
    } else if (projectMode === "rw") {
      // FIX1 (FG-376 review): the named, lockfile-keyed multi-volume path is
      // worktree-mode ONLY. A normal rw bind-mount dispatch shares the live
      // host project directory across concurrent tasks — a container-local
      // shared-cache mount here would BE the race this review exists to fix.
      // Also covers the (should-not-happen) case of a worktree dispatch whose
      // caller never resolved a cache key (no lockfile) — same legacy fallback.
      args.push("-v", legacyShadowPath);
      args.push("-e", `FORGE_NM_SHADOW=${legacyShadowPath}`);
    } else if (projectMode === "ro" && ctx.DEPENDENCY_CACHE_MOUNT_RO === "1") {
      // Reviewers/reds (including the Shipping-Reviewer) never provision —
      // they only reuse an ALREADY-populated cache, mounted read-only, so
      // review containers never race an install and never write into it.
      let plan;
      try {
        plan = planDependencyVolumes(ctx.PROJECT_DIR, projectContainerPath);
      } catch {
        plan = undefined;
      }
      if (plan) {
        for (const v of plan.volumes) {
          args.push("-v", `${v.name}:${v.containerPath}:ro`);
        }
      }
    }
    // projectMode === "ro" without DEPENDENCY_CACHE_MOUNT_RO: cache isn't
    // ready yet — proceed with no dependency-cache mount at all (never block,
    // never install; matches pre-existing reviewer behavior).
  }

  // FG-559 piece B: when PROJECT_DIR is a linked git worktree, bind the parent
  // repo's .git READ-ONLY at its own host absolute path so the worktree's
  // `gitdir:` pointer resolves in the container. `:ro` for EVERY agent class,
  // blue and red alike — PROJECT_MODE (rw-for-blue / ro-for-red) is unrelated
  // and unchanged. Computed here, NOT declared in runtime YAML: the mount set
  // is spread across six seeds/runtimes/*.yml resolved from a versioned seed
  // generation, so a YAML-declared mount would silently keep the broken
  // behavior on any generation that wasn't regenerated. Same shape as the
  // FG-376 dependency volumes above — a dynamic, conditional mount in code.
  //
  // FG-621 rides the SAME loop for the private-clone substrate, with a narrower
  // path: the parent's `.git/objects` ALONE, never the parent `.git`. Read-only
  // is the same for every agent class, and PROJECT_MODE stays unrelated.
  if (projectContainerPath) {
    for (const gitPath of planWorktreeGitMounts(ctx.PROJECT_DIR, ctx.CANONICAL_PROJECT_DIR)) {
      args.push("-v", `${gitPath}:${gitPath}:ro`);
    }
  }

  // FG-608: the live, project-scoped, backlog-only ticket authority. Mounted as a
  // READ-ONLY DIRECTORY for every agent class, blue and red alike — PROJECT_MODE is
  // unrelated and unchanged. Computed here in code (not declared in runtime YAML)
  // for the same reason as the FG-559 git mounts: the mount set is spread across
  // six seeds/runtimes/*.yml resolved from a versioned seed generation, so a
  // YAML-declared mount would silently keep the old behavior on any generation
  // nobody regenerated.
  //
  // The full ~/.forge/forge.db is NEVER mounted: this directory holds a snapshot
  // database containing only this project_key's tickets/relations/blocker evidence,
  // and no runs / tasks / events / gates / verdicts tables at all. Project isolation
  // is structural, not a WHERE clause the agent could drop.
  const snapshotMount = prepareBacklogSnapshotMount(ctx.PROJECT_DIR, ctx.TASK_ID, ctx.TICKET_ID);
  if (snapshotMount) {
    args.push("-v", `${snapshotMount.hostDir}:${snapshotMount.containerDir}:ro`);
    args.push("-e", `FORGE_BACKLOG_SNAPSHOT_DIR=${snapshotMount.containerDir}`);
    if (snapshotMount.dispatchedTicket) {
      // Dispatch-time evidence and live authority are TWO records; neither
      // overwrites the other. The container surfaces both when they differ.
      args.push("-e", `FORGE_DISPATCHED_TICKET=${snapshotMount.dispatchedTicket}`);
    }
  }

  // Working directory = the persistent project bind mount (not the image's
  // ephemeral /workspace WORKDIR). Aligns Claude runtimes with codex (which
  // already targets /project) and with every agent seed's /project contract,
  // so cwd-relative writes persist to the host instead of vanishing on exit.
  if (projectContainerPath) {
    args.push("-w", projectContainerPath);
  }

  // Image.
  const imageIndex = args.length;
  args.push(runtime.image);

  // Invocation command + args (each arg substituted).
  args.push(substitute(runtime.invocation.command, ctx));
  for (const arg of runtime.invocation.args) {
    args.push(substitute(arg, ctx));
  }

  // Agent-container isolation: claude-code auto-discovers settings from cwd
  // (`<cwd>/.claude/settings*.json`). Since cwd is the project bind mount, the
  // orchestrator's own host-side project settings would otherwise leak into
  // the agent — its `env.CLAUDE_CODE_USE_BEDROCK`, `model`, and `hooks` blocks
  // can flip auth, swap models, and crash on host-only hook paths. Suppress
  // all on-disk discovery (user + project + local) so agents are driven only
  // by what forge passes explicitly via env + --model + --append-system-prompt.
  // Gated on claude-code runtimes — codex/pi CLIs would reject the flag.
  if (resolveRuntimeMetadata(runtime).runtimeKind === "claude-code") {
    args.push("--setting-sources", "");
  }

  const stdin = runtime.invocation.stdin
    ? substitute(runtime.invocation.stdin, ctx)
    : undefined;

  // FG-559 piece A: refuse to hand docker an argv that mounts a linked
  // worktree without the parent .git it points into. Gated on the project
  // actually being mounted — a runtime that mounts no project has no
  // in-container git to be blind about.
  if (projectContainerPath) assertWorktreeGitMountPlanned(ctx.PROJECT_DIR, args, ctx.CANONICAL_PROJECT_DIR);

  // FG-497: fail fast, on the host, before exec — not with a bare E2BIG death
  // inside the container. Checks every argv string, including each "-e
  // KEY=VALUE" env pair (labeled by KEY for a useful diagnostic).
  for (let i = 0; i < args.length; i++) {
    const label = args[i - 1] === "-e" ? `env ${args[i]!.split("=")[0]}` : `argv[${i}] ("${args[i - 1] ?? ""}")`;
    assertWithinArgLimit(label, args[i]!);
  }

  return { args, stdin, imageIndex };
}

/** The in-container path the runtime's project mount lands at (e.g.
 *  "/project"). Shared by buildDockerArgs's own mount loop and by
 *  buildProvisionerDockerArgs below, which needs the SAME path so a
 *  DependencyVolumePlan computed against it lines up between the provisioner
 *  and the agent container that reuses it read-only. */
export function resolveProjectContainerPath(runtime: Runtime): string | undefined {
  return runtime.mounts.find((m) => m.host === "${PROJECT_DIR}")?.container;
}

/** Docker args for the FG-376 short-lived dependency-cache provisioner: a
 *  DEDICATED install container, not the agent. Mounts the repo READ-ONLY
 *  (npm ci never writes to project source — planDependencyVolumes only
 *  produces a plan when a package-lock.json exists, so the entrypoint's
 *  install branch always runs `npm ci`, never `npm install`) plus every
 *  plan volume READ-WRITE (the only place these volumes are ever writable),
 *  runs the SAME agent-entrypoint.sh install contract
 *  (FORGE_NM_INSTALL_ROOT / FORGE_NM_SHADOW_PATHS / exit
 *  DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE on failure) against a trivial
 *  no-op command, and exits — no agent invocation, no auth, no browser-tools.
 *  Caller (runNext.ts, via dependency-provisioning.ts:provisionDependencyCache)
 *  runs this under the short cache-key lock and is responsible for the exit
 *  code / marker decision; this function only builds the argv.
 *
 *  Named via provisionerContainerName(plan.lockfileHash) — by CACHE KEY, not
 *  ctx.TASK_ID (FG-376 FIX1). That matches the provisioning lock's own grain
 *  (one provisioner per lockfile hash) so dependency-provisioning.ts's
 *  onDeadHolder can identify/kill the exact orphaned container from LockInfo
 *  alone, without needing a taskId. It also gets a free second guard:
 *  `docker run --name` refuses to start a second container under a name
 *  that's still running. */
export function buildProvisionerDockerArgs(
  runtime: Runtime,
  ctx: { TASK_ID: string; PROJECT_DIR: string; CANONICAL_PROJECT_DIR?: string },
  plan: DependencyVolumePlan,
): string[] {
  const projectContainerPath = resolveProjectContainerPath(runtime) ?? "/project";
  const args: string[] = ["run", "--rm", "-i"];
  args.push("--name", provisionerContainerName(plan.lockfileHash));
  args.push("-e", "FORGE_NO_BROWSER=1");
  args.push("-v", `${ctx.PROJECT_DIR}:${projectContainerPath}:ro`);
  // FG-559: same read-only parent-.git bind as the agent container gets. The
  // provisioner runs the shared entrypoint, whose git probe would otherwise
  // refuse a worktree project. FG-621: on the private-clone substrate the same
  // call yields the parent's object store instead — the provisioner sees the
  // identical narrow, read-only view the agent container gets, verified against
  // the same Forge-owned parent. It starts BEFORE the agent container, so it is
  // the first place the derive-and-compare has to hold, not the second.
  for (const gitPath of planWorktreeGitMounts(ctx.PROJECT_DIR, ctx.CANONICAL_PROJECT_DIR)) {
    args.push("-v", `${gitPath}:${gitPath}:ro`);
  }
  for (const v of plan.volumes) {
    args.push("-v", `${v.name}:${v.containerPath}`); // rw — the ONLY container allowed to write here
  }
  args.push("-e", `FORGE_NM_SHADOW_PATHS=${plan.volumes.map((v) => v.containerPath).join(":")}`);
  args.push("-e", `FORGE_NM_INSTALL_ROOT=${plan.installRoot}`);
  args.push("-w", projectContainerPath);
  args.push(runtime.image);
  args.push("true"); // entrypoint installs, then execs this trivial no-op and exits 0
  // FG-559 piece A: the provisioner is a container too, and on a worktree
  // dispatch it starts BEFORE the agent container — so the same refusal has to
  // hold here, not only in buildDockerArgs. A git bind the argv cannot express
  // (a host path holding a `:`) is emitted above and caught here.
  assertWorktreeGitMountPlanned(ctx.PROJECT_DIR, args, ctx.CANONICAL_PROJECT_DIR);
  return args;
}

// FG-374: verify that the resolved projectDir is mountable before exec'ing.
// Hard-fails only for genuinely broken mounts: missing path or non-directory.
// Empty dirs and marker-less dirs are valid (tests use bare mkdtemp dirs;
// forge supports non-git/non-npm project layouts) — they emit a warning only.
// Call this just before exec — after buildDockerArgs succeeds.
export function preflightProjectMount(projectDir: string): void {
  const stat = statSync(projectDir, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(
      `project mount preflight failed: ${projectDir} does not exist — ` +
        `verify the correct project directory is mounted at /project`
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `project mount preflight failed: ${projectDir} is not a directory — ` +
        `verify the correct project directory is mounted at /project`
    );
  }
  const entries = readdirSync(projectDir);
  if (entries.length === 0) {
    console.warn(
      `forge: project mount preflight: ${projectDir} is empty — ` +
        `verify the correct project directory is mounted at /project`
    );
    return;
  }
  const dotGit = statSync(join(projectDir, ".git"), { throwIfNoEntry: false });
  const hasPkg = existsSync(join(projectDir, "package.json"));
  if (!dotGit && !hasPkg) {
    console.warn(
      `forge: project mount preflight: ${projectDir} has no .git or package.json — ` +
        `proceeding; verify this is the intended project root`
    );
  }
  // FG-559: `.git` existing is NOT evidence of a usable repo. For a linked
  // worktree it is a `gitdir:` pointer FILE, and the bare existsSync this
  // replaced read that as a healthy marker — the seam the whole defect walked
  // through. A pointer whose target is gone is broken on the HOST too, so
  // refuse rather than dispatch an agent that cannot run git. (A pointer that
  // resolves host-side but is not MOUNTED is a different failure, caught by
  // assertWorktreeGitMountPlanned against the argv, not by a filesystem stat.)
  if (dotGit?.isFile()) {
    const target = readGitdirPointer(projectDir);
    if (!target || !existsSync(target)) {
      throw new Error(
        `project mount preflight failed: ${projectDir}/.git is a gitdir: pointer to ` +
          `${target ?? "an unparseable path"}, which does not exist on the host — ` +
          `the worktree's parent repo is missing or the worktree was pruned`
      );
    }
  }
}

// Exported for tests so we can assert env-pairs and mount-pairs.
export const _internal = {
  buildDockerArgs,
};

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const FORGE_HOME = process.env.FORGE_HOME ?? join(homedir(), ".forge");
export const RUNS_DIR = join(FORGE_HOME, "runs");
export const AGENTS_DIR = join(FORGE_HOME, "agents");
export const CONSTRAINTS_DIR = join(FORGE_HOME, "constraints");
// FG-351: git worktrees live under WORKTREES_DIR/<runId>/<taskId>. Inside
// Docker Desktop's macOS file-sharing allowlist (under ~/.forge).
export const WORKTREES_DIR = join(FORGE_HOME, "worktrees");
// FG-621: private per-task `git clone --shared` workspaces for MUTATING agents.
// Namespaced under WORKTREES_DIR the same way PUBLICATIONS_DIR is — every forge
// workspace stays under one managed root (and inside Docker Desktop's macOS
// file-sharing allowlist) — but on its OWN prefix, because the two substrates are
// disposed of by different machinery: a linked worktree through `git worktree
// remove`, a clone by removing the directory that IS the repository. A path that
// could resolve to both is a path the reaper could act on with the wrong proof.
export const CLONES_DIR = join(WORKTREES_DIR, "clones");
// FG-425: per-ATTEMPT integration worktrees for the serialized publisher. Lives
// under FORGE_HOME, NEVER inside projectDir: publisher bookkeeping written into
// the publish target would register as target dirt (tripping AD-3's dirty check
// against itself) and would be swept into the very fast-forward it coordinates.
export const PUBLICATIONS_DIR = join(WORKTREES_DIR, "publications");
// The installed host RACI source (authoring view). `forge raci validate` lints
// this by default.
export const RACI_PATH = join(FORGE_HOME, "forge-raci.md");
// Installed workflows; the derived routing policy. `forge route validate`
// resolves workflow symbols against WORKFLOWS_DIR and lints ROUTING_POLICY_PATH
// by default.
export const WORKFLOWS_DIR = join(FORGE_HOME, "workflows");
export const ROUTING_POLICY_PATH = join(FORGE_HOME, "routing-policy.yml");
// FG-579: host/orchestrator workflow skills install OUTSIDE $FORGE_HOME, into the
// user-global Claude Code skills dir. Resolution mirrors install-seeds.sh's
// CLAUDE_SKILLS_DEST byte-for-byte (CLAUDE_SKILLS_DEST → CLAUDE_CONFIG_DIR/skills
// → ~/.claude/skills), so the seed-drift detector compares against exactly the
// tree the installer wrote.
export const CLAUDE_SKILLS_DIR =
  process.env.CLAUDE_SKILLS_DEST ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "skills");
// Append-only JSONL audit trail of orchestrator-mediated RACI changes (#279).
// One line per `forge raci apply --confirm`; host-global, outside any repo.
export const RACI_AUDIT_LOG_PATH = join(FORGE_HOME, "raci-audit.log");
// FORGE_DB_PATH overrides the default; pass `:memory:` in tests for an in-memory SQLite.
//
// FG-607 made this module reachable from `@forge/backlog` (src/backlog/structured.ts
// now imports src/store/db.ts for the db-mode seam), so paths.ts can be EVALUATED
// before the importing module's own body runs — ESM evaluates static imports first.
// Anything that sets process.env.FORGE_HOME programmatically after importing the
// backlog seam therefore gets a snapshot of the WRONG home, and the store silently
// opens another host's forge.db. The consts stay a process-start snapshot (a CLI's
// env genuinely is fixed at process start, and 100+ call sites read them); the
// store path additionally resolves at OPEN time, because it is the one path whose
// staleness reads and writes a different host's data rather than merely misnaming a
// directory. Same expression, two consumers — never two definitions.
export function resolveDbPath(): string {
  return process.env.FORGE_DB_PATH ?? join(process.env.FORGE_HOME ?? join(homedir(), ".forge"), "forge.db");
}
export const DB_PATH = resolveDbPath();

// FG-571 (FG-553 Child 4): the promotion surface. EVERY path here is derived from a
// `home` argument (defaulting to FORGE_HOME) rather than homedir() — setting FORGE_HOME
// therefore isolates a promotion, an interpreter install, and a shim install COMPLETELY.
// That is not an ergonomic nicety: it is the mechanism that keeps a test that promotes,
// rolls back, or installs an interpreter away from the operator's REAL ~/.forge/current
// and their live control plane. A hardcoded homedir() on any of these paths would break it.
export function releasesDirIn(home: string): string {
  return join(home, "releases");
}
// NOT `runtimes/`: that name is already taken on a real forge home by the PROVIDER RUNTIME
// REGISTRY (~/.forge/runtimes/*.yml — claude-oauth.yml, pi-apikey.yml, ...), which
// `forge doctor` enumerates. The interpreter store is an unrelated meaning of "runtime";
// nesting it inside the provider config dir would conflate the two and break any future
// enumeration that does not filter on `.yml`.
export function interpretersDirIn(home: string): string {
  return join(home, "interpreters");
}
export function currentLinkIn(home: string): string {
  return join(home, "current");
}
export function previousLinkIn(home: string): string {
  return join(home, "previous");
}
// The selection PAIR (`current` + `previous`) is one state, so it gets one commit point:
// $FORGE_HOME/current and $FORGE_HOME/previous are static links THROUGH $FORGE_HOME/selection,
// which names a directory holding the two release pointers. Swapping that one link publishes
// both at once — two independent renames could never be atomic as a pair.
export function selectionLinkIn(home: string): string {
  return join(home, "selection");
}
export function selectionsDirIn(home: string): string {
  return join(home, "selections");
}
// FG-571 — THE UNIT EVIDENCE LEDGER. Forge-authored, create-only provenance for every unit
// forge itself materialized, validated, froze, and published: what directory it published,
// and the full-SHA-256 digest of the bytes it froze there.
//
// It lives OUTSIDE `releases/` because `releases/<id>` is the ATTACKER-ADDRESSABLE namespace:
// the id comes from a candidate's own manifest, so anyone who can write the store can place a
// directory at a name a later `forge release promote <id>` will look up. Nothing INSIDE that
// namespace can vouch for its own contents — a hand-placed unit would carry a hand-placed
// record. This ledger is the counterpart forge owns: a unit with no entry here is one forge
// never published, whatever its location, id, or permissions say.
export function unitsDirIn(home: string): string {
  return join(home, "units");
}

export const RELEASES_DIR = releasesDirIn(FORGE_HOME);
export const INTERPRETERS_DIR = interpretersDirIn(FORGE_HOME);
export const CURRENT_LINK = currentLinkIn(FORGE_HOME);
export const PREVIOUS_LINK = previousLinkIn(FORGE_HOME);

// FG-583 — THE SEED GENERATION POINTER. Forge-owned, dispatch-coupled host seeds
// (workflows, runtimes, the derived compiled routing policy) are published as ONE
// atomic generation, committed by a single rename(2) over a dedicated pointer that
// resolves THROUGH a stable selection dir — the exact promote.ts vocabulary, but a
// DISTINCT pointer pair from FG-571's interpreter `current`/`previous`. Seed refresh
// therefore works WITHOUT interpreter promotion.
//
// The relative-link shape mirrors selectionLinkIn/currentLinkIn: `seed-current` and
// `seed-previous` are static links THROUGH `seed-selection`, so a moved or
// bind-mounted home still resolves the chain. Every path derives from `home`, so a
// disposable FORGE_HOME isolates a publication completely from the operator's real
// ~/.forge — the mechanism that keeps tests off the real host.
export function seedGenerationsDirIn(home: string): string {
  return join(home, "seed-generations");
}
export function seedSelectionsDirIn(home: string): string {
  return join(home, "seed-selections");
}
export function seedSelectionLinkIn(home: string): string {
  return join(home, "seed-selection");
}
export function seedCurrentLinkIn(home: string): string {
  return join(home, "seed-current");
}
export function seedPreviousLinkIn(home: string): string {
  return join(home, "seed-previous");
}

export function ensureForgeDirs(): void {
  for (const dir of [FORGE_HOME, RUNS_DIR, AGENTS_DIR, CONSTRAINTS_DIR, WORKTREES_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function runDir(runId: string): string {
  return join(RUNS_DIR, runId);
}

export function taskDir(runId: string, taskId: string): string {
  return join(RUNS_DIR, runId, taskId);
}

// FG-351: path where a task's git worktree is checked out.
export function worktreeDir(runId: string, taskId: string): string {
  return join(WORKTREES_DIR, runId, taskId);
}

// FG-621: path where a mutating task's private `--shared` clone lives. Distinct
// from worktreeDir() by construction — a clone must never be able to collide
// with (or be mistaken for) a linked worktree.
export function cloneDir(runId: string, taskId: string): string {
  return join(CLONES_DIR, runId, taskId);
}

// FG-353: path where the fan-out integration worktree is checked out.
export function integrationWorktreeDir(runId: string, parentTaskId: string): string {
  return join(WORKTREES_DIR, runId, parentTaskId, "integration");
}

// FG-425 (AD-4): path for a publication attempt's candidate worktree. Keyed on
// the ATTEMPT (and the rebuild ordinal within it), never on (runId, taskId) —
// a moved-base rebuild must get a FRESH tree and must not destroy the first
// attempt's tree, which is the evidence AD-1 requires be preserved on a park.
export function publicationWorktreeDir(attemptId: string, rebuild = 0): string {
  return join(PUBLICATIONS_DIR, `${attemptId}-r${rebuild}`);
}

// FG-566: durable HOST-side verification readiness assertions, one record per
// prepared workspace. A DELIBERATELY SEPARATE KEYSPACE from FG-376's
// ~/.forge/dependency-cache/, and the two must never be written by each other:
// the container cache key is ABI-FREE by design (the agent image pins the
// interpreter, so a lockfile hash fully identifies the install), while the host
// key MUST include the runtime/ABI because the host interpreter varies per
// operator. Writing FG-376's marker from here would make runNext's
// isDependencyCacheReady skip container provisioning against an empty volume.
//
// Resolved at CALL time (not a module-eval const) for the same reason
// resolveDbPath is: this is a path whose staleness would read and write ANOTHER
// forge home's readiness assertions rather than merely misnaming a directory.
export function hostReadinessDir(): string {
  return join(process.env.FORGE_HOME ?? join(homedir(), ".forge"), "host-readiness");
}

// FG-566: HOST-LEVEL operator configuration. The one file a tree under review
// cannot influence: it lives in the operator's forge home, outside every project
// checkout, so no reviewed change and no merged agent branch can reach it. The
// host-side verification setup COMMAND is read from here and nowhere else —
// `<project>/.forge/config.json` is inside the workspace under test and is
// therefore attacker-selectable input to an execFileSync that runs with forge's
// host identity. Resolved at CALL time, same as hostReadinessDir.
export function hostConfigPath(): string {
  return join(process.env.FORGE_HOME ?? join(homedir(), ".forge"), "config.json");
}

// Host path of the PROMPT.md a prompt-author task wrote. The agent writes to
// `/task/PROMPT.md` (in-container); that bind-mounts to taskDir() on the host.
// The dashboard renders the prompt body inline; validation works off the run's
// designDir, not the prompt path.
export function briefPromptHostPath(runId: string, briefTaskId: string): string {
  return join(taskDir(runId, briefTaskId), "PROMPT.md");
}

// Expand a leading `~` in a path to the user's home directory. Forge stores
// projectDir / designDir verbatim, but downstream consumers (docker -v, fs
// existsSync) don't do shell-style expansion. The dashboard's POST body
// likewise never goes through a shell. So we expand once at run creation —
// after that everything sees an absolute path. Returns absolute paths
// unchanged; returns relative paths unchanged (caller decides what to do).
export function expandTildePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Sanitize a run title to a filename slug. Source of truth for the
// `<sanitized-title>.pen` convention used by ui-design / ui-design-revise / feature-ui-design-needed workflows.
// Both `forge new --design-dir` defaulting and design validation share this rule
// so the .pen file produced by Pencil and the .pen file expected by the validator
// are guaranteed to match.
export function sanitizeTitleForFilename(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

// FG-569 (FG-553 Child 2) — the release-closure BUILDER + R1 provenance.
//
// A release is a self-contained, IMMUTABLE directory that carries everything the
// declared control-plane command set AND the dashboard application need to run without
// consulting PATH or the ambient environment. "Self-contained" is recorded on the
// manifest as `selfContainedFor: "control-plane+dashboard"` (FG-580, Option A): the
// dashboard runtime source, its static client assets, its VENDORED client libs (offline
// boot — no CDN-executed JS), and dashboard-relevant deps are all bundled and commit-bound,
// so `forge dashboard` runs from a release. Every SUPPORTED command's module-relative
// assets ARE bundled, so none of them silently falls back to a source checkout:
//
//   <release>/
//     forge-release.json   the manifest (commit, absolute interpreter, ABI, lockfile identity)
//     forge                the entry: `#!/bin/sh` that execs the PINNED absolute node
//     forge-loader.mjs     the in-process tsx loader (import "tsx")
//     src/                 the source tree
//     seeds/               agent seeds, forge-raci.md, orchestrator-template.md, seed-drift baseline
//     scripts/             git-hooks, claude-hooks, claude-commands, install-seeds.sh
//     docker/              build.sh + Dockerfile (doctor image probe, upgrade --rebuild-image)
//     node_modules/        the ENTIRE dependency closure, incl. the compiled native binding
//     package.json, package-lock.json
//
// seeds/ + scripts/ + docker/ are REQUIRED, not optional: a supported command whose
// module-relative asset dir is absent at build time is a TORN CLOSURE refusal, not a
// silent skip (the shipped release would carry a command that cannot find its own
// assets). They are commit-bound like src/ (see assertCommitDescribesTree), so a dirty
// seed/hook/docker file refuses the build for the same reason a dirty src/ does.
//
// The entry execs an ABSOLUTE interpreter with tsx loaded in-process (--import),
// so exactly one process exists and it is the one that loads better-sqlite3 — its
// process.execPath IS the runtime the manifest names (R1), provable by executing
// the entry under a hostile PATH with no node at all.
//
// This module is INERT: it BUILDS a release. It never promotes, never writes a
// `current` symlink, never touches PATH. Promotion is Child 4.
//
// TORN CLOSURE is refused AT BUILD: before anything is copied, the builder loads
// the source root's compiled better-sqlite3 binding under the building
// interpreter. A node_modules whose native binding is missing, corrupt, or
// ABI-mismatched cannot load — so a torn closure never becomes a release.

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { findGitRoot } from "../util/git-root.js";
import { installInterpreter } from "./runtime-store.js";

export const RELEASE_MANIFEST_NAME = "forge-release.json";
export const RELEASE_ENTRY_NAME = "forge";
export const RELEASE_LOADER_NAME = "forge-loader.mjs";
export const RELEASE_BINDING_REL = "node_modules/better-sqlite3/build/Release/better_sqlite3.node";
export const RELEASE_ENTRY_SOURCE = "src/cli/index.ts";

// FG-571 — THE CANONICAL EXECUTION DESCRIPTOR. Forge authors it, in trusted Node, INSIDE
// the staged release unit, AFTER that unit's bytes have been parsed and validated. The shim
// consumes ONLY this file; it never parses the candidate's raw JSON manifest again.
//
// WHY IT EXISTS. The shim's job is to FIND the interpreter, so it runs before any
// interpreter is available and must read its instructions with POSIX sh alone. A
// hand-rolled sh line-matcher over JSON does not have JSON.parse's semantics — duplicate
// keys, grammar, escapes, and embedded newlines all resolve differently — so a manifest
// could pass promotion's JSON.parse validation and still hand the sh reader a DIFFERENT
// interpreter to exec. Chasing byte-for-byte agreement between two parsers forever is the
// losing side of that battle. So the invariant moves instead: trusted Node does all
// parsing and validation, and the shim consumes only forge-authored data. Divergence
// becomes impossible BY CONSTRUCTION rather than by matching two parsers.
//
// WHY IT LIVES INSIDE THE UNIT. A separately-swapped sibling record next to `current` is
// forbidden: a record swap plus a pointer swap is not atomic AS A PAIR, so it would create
// exactly the mismatch window this exists to close. The descriptor ships INSIDE the
// immutable unit, so the single `current` swap selects the release and its descriptor
// together and there is nothing to desynchronize.
export const RELEASE_EXEC_NAME = "forge-exec";

// EXACTLY TWO FIELDS, in this order — the only two values that genuinely VARY between
// releases. Everything else the shim needs is a FIXED schema constant (RELEASE_ENTRY_SOURCE,
// RELEASE_LOADER_NAME) baked into the shim text at render time, so it is never dynamic input
// and can never be redirected by anything on disk.
const EXEC_FIELDS = ["interpreter", "release"] as const;

// RESTRICTED CHARACTER SETS, enforced identically here and in the shim. Neither admits a
// newline, quote, backslash, `$`, backtick, whitespace, glob metacharacter, or any shell
// operator — so a value can never be read as shell syntax even if something later dropped a
// quote. `+` and `_` are in the interpreter's set because real temp/home paths (notably
// macOS's /var/folders/..) contain them.
const EXEC_INTERPRETER_CHARSET = /^[A-Za-z0-9._/+-]+$/;
const EXEC_ID_CHARSET = /^[A-Za-z0-9._-]+$/;
// The same two sets, as POSIX sh bracket expressions. `!` negates; `-` is last, so it is a
// literal rather than a range. Kept beside the regexes above so the two cannot drift apart.
const SH_INTERPRETER_CHARSET = "A-Za-z0-9._/+-";
const SH_ID_CHARSET = "A-Za-z0-9._-";

export type ExecDescriptor = { interpreter: string; id: string };

/** AUTHOR the canonical descriptor. Forge writes it, so it is exact by construction — but
 *  it is validated on the way out anyway: a value that the shim would refuse must never be
 *  written into a unit in the first place, or the refusal surfaces at the operator's next
 *  `forge` invocation instead of at promotion. */
export function renderExecDescriptor(d: ExecDescriptor): string {
  if (!isAbsolute(d.interpreter) || !EXEC_INTERPRETER_CHARSET.test(d.interpreter)) {
    throw new Error(
      `forge release: refusing to author an execution descriptor for a non-canonical interpreter path.\n` +
        `  interpreter: ${JSON.stringify(d.interpreter)}\n` +
        `The descriptor is consumed by the machine-wide shim, which requires an absolute path drawn from ` +
        `[${SH_INTERPRETER_CHARSET}] — so a path forge cannot express there is refused here rather than ` +
        `written into a release the shim would then refuse to run.`,
    );
  }
  if (!EXEC_ID_CHARSET.test(d.id)) {
    throw new Error(
      `forge release: refusing to author an execution descriptor for a malformed release identity.\n` +
        `  release id: ${JSON.stringify(d.id)}\n` +
        `A release identity is a plain token drawn from [${SH_ID_CHARSET}].`,
    );
  }
  return `${EXEC_FIELDS[0]} ${d.interpreter}\n${EXEC_FIELDS[1]} ${d.id}\n`;
}

/** VALIDATE descriptor bytes with exactly the rules the shim enforces: exact field count,
 *  fixed order, fixed prefix, restricted character set. Structural duplicates and extra
 *  fields cannot survive a fixed-order fixed-count check, so they need no separate rule.
 *  Returns a reason rather than throwing — both callers (the promotion gate and the tests)
 *  want to name what was wrong. */
export function parseExecDescriptor(text: string): { ok: true; value: ExecDescriptor } | { ok: false; reason: string } {
  const lines = text.split("\n");
  // Forge always terminates the last field. An unterminated final line is a TORN
  // descriptor, and the shim's `read` loop drops it (yielding a short field count), so it
  // must be refused here too rather than silently accepted.
  if (lines.pop() !== "") return { ok: false, reason: "the descriptor does not end with a newline (torn or truncated)" };
  if (lines.length !== EXEC_FIELDS.length) {
    return { ok: false, reason: `the descriptor states ${lines.length} field(s); exactly ${EXEC_FIELDS.length} are required` };
  }
  const values: string[] = [];
  for (const [i, field] of EXEC_FIELDS.entries()) {
    const line = lines[i]!;
    const prefix = `${field} `;
    if (!line.startsWith(prefix) || line.length === prefix.length) {
      return { ok: false, reason: `field ${i + 1} is not a non-empty \`${field}\` field: ${JSON.stringify(line)}` };
    }
    values.push(line.slice(prefix.length));
  }
  const [interpreter, id] = values as [string, string];
  if (!isAbsolute(interpreter)) return { ok: false, reason: `the interpreter is not absolute: ${JSON.stringify(interpreter)}` };
  if (!EXEC_INTERPRETER_CHARSET.test(interpreter)) {
    return { ok: false, reason: `the interpreter holds a character outside [${SH_INTERPRETER_CHARSET}]: ${JSON.stringify(interpreter)}` };
  }
  if (!EXEC_ID_CHARSET.test(id)) return { ok: false, reason: `the release id holds a character outside [${SH_ID_CHARSET}]: ${JSON.stringify(id)}` };
  return { ok: true, value: { interpreter, id } };
}

export type ReleaseManifest = {
  schema: 1;
  id: string;
  // The commit of the --source checkout, BOUND to the shipped src/+package.json+
  // lockfile bytes: buildRelease refuses a dirty source, so this commit always
  // describes what was copied. (FG-569 GAP 2 — a dirty source made this lie.)
  commit: string;
  // The RUNNING builder's own commit — the checkout that produced the generated
  // entry (renderEntry) and loader (LOADER_SHIM) bytes. Distinct from `commit` so a
  // release built by builder A from a different --source checkout B never presents
  // B's commit as if it also produced the entry/loader. Equal to `commit` on the
  // normal self-build (builder and source are the same checkout).
  builderCommit: string;
  // The ABSOLUTE interpreter the entry execs — the whole point of the closure is
  // to depend on NO PATH lookup. FG-571: this is the INTERPRETER STORE's keyed path
  // ($FORGE_HOME/interpreters/node-<version>-<abi>/bin/node), never the building
  // process.execPath directly: the store is what makes the reference immutable. See
  // buildRelease, and isStoredInterpreter for the rule promotion enforces on it.
  interpreter: string;
  abi: string; // process.versions.modules — the exact ABI the native binding needs
  nodeVersion: string;
  lockfile: { name: string; sha256: string };
  builtAt: string;
  entry: string; // RELEASE_ENTRY_SOURCE, relative to the release root
  binding: string; // RELEASE_BINDING_REL, relative to the release root
  // FG-580: the "self-contained" claim, widened TRUTHFULLY now that the dashboard is
  // bundled (operator decision, Option A). This release closes over the control-plane
  // command set AND the dashboard application: the dashboard runtime source, its static
  // client assets, its VENDORED client libs (offline boot — no CDN-executed JS), and the
  // dashboard-relevant runtime deps all ship in-closure and are commit-bound. The value
  // is recorded so a reader can trust `forge dashboard` runs from this release, not that
  // it is control-plane-only.
  selfContainedFor: "control-plane+dashboard";
};

// FG-569 (Resolution B): asset directories a SUPPORTED control command resolves
// module-relative to the release root (seeds via init/upgrade/doctor-seed-drift,
// scripts via init hooks + upgrade install-seeds, docker via doctor image probe +
// upgrade --rebuild-image). REQUIRED — absence is a torn-closure refusal, and each is
// commit-bound so a dirty asset refuses the build. `dashboard/` is deliberately absent
// from THIS list: it is a separate npm workspace tracked via DASHBOARD_TRACKED_PATHS (a
// distinct path set), not a control-plane asset dir — but it is bundled and commit-bound
// all the same (FG-580, Option A). Bound paths for the commit check add package.json + the
// selected lockfile;
// node_modules is lockfile-bound separately, not part of the commit's source identity.
const REQUIRED_ASSET_DIRS = ["seeds", "scripts", "docker"] as const;

// FG-580: the dashboard is now BUNDLED into the release (operator decision, Option A).
// These git-tracked dashboard paths ship in the same committed snapshot as src/ + the
// bundled asset dirs, preserving the `dashboard/`↔`src/` SIBLING layout so the
// dashboard's tsconfig-paths `@forge/*` → `../src/*.ts` still resolves at runtime
// (cwd=<release>/dashboard). browser-tests/ and design/ are deliberately excluded —
// they are not runtime inputs. Kept as an explicit path list (not a bare `dashboard`)
// so a stray untracked dir never enters the closure and the census's exclusions hold.
const DASHBOARD_TRACKED_PATHS = [
  "dashboard/src",
  "dashboard/client",
  "dashboard/package.json",
  "dashboard/tsconfig.json",
] as const;

// FG-580: the dashboard runtime files a promoted release MUST carry. Absence of ANY is
// a torn closure — the build refuses BY NAME, and `forge dashboard` from a torn release
// fails named+nonzero rather than silently reaching for a dev checkout. This is the
// COMPLETE runtime source/static closure, not a representative sample: a release missing
// any one of these boots into broken runtime behavior or a blank page (a dropped server
// module aborts startup; a dropped client module breaks the ES-module graph the browser
// loads; a dropped favicon/logo 404s), so each is required by name rather than trusting
// that shipping `server.ts` + `main.js` implies the rest arrived. Kept in sync with
// server.ts's import graph, main.js's ES-module graph, dashboard/src/shell.ts's referenced
// assets + import map, and scripts/vendor-dashboard-libs.mjs.
export const REQUIRED_DASHBOARD_FILES = [
  // Server runtime source — server.ts's own local import graph (./queries, ./shell,
  // ./plan-usage, ./http-error). A missing one aborts `forge dashboard start` at import.
  "dashboard/src/server.ts",
  "dashboard/src/queries.ts",
  "dashboard/src/shell.ts",
  "dashboard/src/plan-usage.ts",
  "dashboard/src/http-error.ts",
  "dashboard/package.json",
  "dashboard/tsconfig.json",
  // Client ES-module graph — main.js and everything it (transitively) imports. A missing
  // module makes the browser's module loader fail and the app never mounts.
  "dashboard/client/main.js",
  "dashboard/client/renderers.js",
  "dashboard/client/usage.js",
  "dashboard/client/usage-limits.js",
  "dashboard/client/governance.js",
  "dashboard/client/backlog.js",
  "dashboard/client/verification-render.js",
  "dashboard/client/verification-label.js",
  // Static assets the shell + client reference by URL (favicons, apple-touch icon, brand
  // marks). A missing one 404s rather than serving the intended asset.
  "dashboard/client/favicon-16.png",
  "dashboard/client/favicon-32.png",
  "dashboard/client/favicon-48.png",
  "dashboard/client/apple-touch-icon.png",
  "dashboard/client/icon-192.png",
  "dashboard/client/icon-512.png",
  "dashboard/client/logo-mark.svg",
  "dashboard/client/claude-logo.png",
  "dashboard/client/openai-logo.png",
  // VENDORED client libs (FG-580 offline boot: no esm.sh/CDN fetch of executable JS —
  // these bytes serve first-party from the closure).
  "dashboard/client/vendor/preact/preact.js",
  "dashboard/client/vendor/preact/hooks.js",
  "dashboard/client/vendor/htm/htm.js",
  "dashboard/client/vendor/marked/marked.js",
] as const;

// FG-580: dashboard-relevant runtime deps that must resolve from the shipped
// node_modules for `forge dashboard` to serve — better-sqlite3 (the dashboard's queries
// open the forge DB via @forge/*) and marked (a declared dashboard dependency). A
// release missing one cannot run the dashboard, so closure validation refuses it.
export const REQUIRED_DASHBOARD_DEPS = ["better-sqlite3", "marked"] as const;

/** FG-580: assert `root` carries the complete dashboard runtime closure — every required
 *  dashboard file (entry, tsconfig, representative static asset, vendored client libs) and
 *  every dashboard-relevant runtime dependency. Throws a NAMED error on the first missing
 *  input. Used both post-copy in buildRelease (a torn build is refused) and at
 *  `forge dashboard` time (a torn/incomplete release fails named+nonzero, never falls back
 *  to a dev checkout). Read-only, so it is safe against a frozen release tree. */
export function assertDashboardClosure(root: string): void {
  for (const rel of REQUIRED_DASHBOARD_FILES) {
    if (!existsSync(join(root, rel))) {
      throw new Error(
        `forge dashboard: torn closure — required dashboard file '${rel}' is missing at ${join(root, rel)}. The release does not carry a complete dashboard runtime (source/static asset/vendored client lib); it was built without the dashboard bundle or is corrupt. Rebuild the release from a source that includes dashboard/ and its vendored client libs (run scripts/vendor-dashboard-libs.mjs).`,
      );
    }
  }
  for (const dep of REQUIRED_DASHBOARD_DEPS) {
    if (!existsSync(join(root, "node_modules", dep, "package.json"))) {
      throw new Error(
        `forge dashboard: torn closure — required dashboard runtime dependency '${dep}' is missing from node_modules at ${join(root, "node_modules", dep)}. The dashboard cannot serve without it. Reinstall dependencies and rebuild the release.`,
      );
    }
  }
}

const LOADER_SHIM = `// FG-569: in-process tsx loader for this release's entry. import "tsx" resolves
// tsx from THIS release's node_modules (relative to this file), not the caller's
// cwd — so the release entry runs from any directory under a node-free PATH.
import "tsx";
`;

// FG-571 (F29) — THE ENV-SANITIZATION LIST. Every variable here is a Node/runtime
// INJECTION vector on the pinned interpreter's own startup path: ambient env that can
// run attacker code, redirect resolution, block startup, or move trust — BEFORE forge's
// first line executes. An absolute pinned interpreter is necessary but NOT sufficient
// (Appendix A2, reproduced on this host: `NODE_OPTIONS=--import ./evil.mjs` runs the
// injected module before the entry point, and `NODE_OPTIONS=--not-a-real-flag` prevents
// startup entirely). Audited against the pinned Node major's own documented environment
// (`node --help`, Node 24) plus the vars it honours without documenting there.
//
// BOUNDED, NOT BROAD. This is an explicit per-variable unset list — deliberately NOT
// `env -i` and not a wholesale wipe. The operator's environment is theirs: PATH, HOME,
// FORGE_HOME, AWS_*, NTFY_*, TERM, LANG and everything else survive UNTOUCHED, because
// forge's own auth modes, notifications, and project resolution read them. Over-broad
// sanitization would be its own defect (it would break bedrock auth and the SSO cache
// path), so a variable earns a place here only by being a startup-injection vector.
//
// WHY each one is on the list:
const SANITIZED_ENV_VARS = [
  // CODE INJECTION — runs attacker code inside the forge process before forge starts,
  // and (with an invalid flag) can block startup outright. The proven red baseline.
  "NODE_OPTIONS",
  // RESOLUTION REDIRECT — prepends caller-chosen directories to the module search path,
  // so a dependency the closure means to load from its OWN node_modules resolves to
  // attacker bytes instead. Defeats the whole point of a self-contained closure.
  "NODE_PATH",
  // RESOLUTION REDIRECT — changes whether module paths are canonicalized through
  // symlinks. The release is reached THROUGH the `current` symlink, so this directly
  // controls which release a process anchors to (T9) — it must not be caller-settable.
  "NODE_PRESERVE_SYMLINKS",
  "NODE_PRESERVE_SYMLINKS_MAIN",
  // CODE INJECTION — loads a caller-named module in place of the built-in REPL.
  "NODE_REPL_EXTERNAL_MODULE",
  // CODE INJECTION (cache poisoning) — points the on-disk V8 compile cache at a
  // caller-controlled directory, where compiled code for the release's own modules is
  // read from and written to. Honoured by the pinned Node 24 (verified on this host).
  "NODE_COMPILE_CACHE",
  // OUTPUT REDIRECT — makes the process write V8 coverage JSON into a caller-chosen
  // directory on exit; a write primitive under whatever privileges forge has.
  "NODE_V8_COVERAGE",
  // RESOLUTION REDIRECT — points ICU data at caller-controlled bytes, read during
  // startup before user code.
  "NODE_ICU_DATA",
  // TLS TRUST — adds caller-chosen CA certificates to the process trust store, read
  // once at startup. forge speaks to Bedrock/Anthropic/GitHub over TLS from this
  // process; a caller-supplied CA silently makes an interception path trusted.
  "NODE_EXTRA_CA_CERTS",
  // TLS TRUST — `=0` disables certificate validation process-wide.
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // STARTUP/DIAGNOSTIC — turns on core debug output on stderr from the caller's choice
  // of subsystems, corrupting the machine-readable surfaces forge's own callers parse
  // and leaking internals.
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  // FG-571 (FG571-RI) — NOT a Node var: the release-identity carrier. Release identity is
  // derived SOLELY from the selected release's manifest and NEVER from ambient env, so
  // a caller-supplied value must never survive to be recorded as provenance. Unsetting
  // here is only half the contract; see renderIdentityGuard for the fail-closed half.
  "FORGE_RELEASE_ID",
  // FG-571 — NOT a Node var: the descriptor's interpreter, carried to trusted Node so it can
  // be cross-checked against the manifest (src/cli/node-preflight.ts). Same rule as the id —
  // it is a value the SHIM sets from forge-authored bytes, so an ambient one must never
  // survive to be mistaken for the descriptor's answer and let a divergent interpreter pass.
  "FORGE_RELEASE_INTERPRETER",
] as const;

/** THE ONE env-sanitization snippet, shared verbatim by the release entry
 *  (renderEntry) and the machine-wide PATH shim (renderShim) so the two can NEVER
 *  drift. The shim is where hostile callers arrive; the entry is what the F29 tests
 *  exercise directly through a promotion symlink — an unset present in one and missing
 *  from the other would be a hole with a passing test suite. `unset` is a shell builtin,
 *  so this consults no PATH, and it runs FIRST: everything after it (including the
 *  pinned interpreter's own realpath call) must already be uninjectable. */
function renderEnvSanitizer(): string {
  return [
    "# FG-571 (F29): neutralize caller Node/runtime-injection vars BEFORE the pinned",
    "# interpreter is reached. BOUNDED — an explicit list, never `env -i`: PATH, HOME,",
    "# FORGE_HOME, AWS_*, NTFY_*, TERM, LANG and the rest of the operator's environment",
    "# survive untouched. See SANITIZED_ENV_VARS in src/v2/release.ts for why each is here.",
    `unset ${SANITIZED_ENV_VARS.join(" ")}`,
  ].join("\n");
}

/** Read `keys` out of a release manifest with SHELL BUILTINS ONLY — no sed, no grep,
 *  no node — so a node-free PATH still touches no external. `manifestVar` names the sh
 *  variable holding the manifest path; each key lands in `__forge_<key>`. One pass over
 *  the file for all keys.
 *
 *  FG-571 — THE RELEASE ENTRY ONLY. The machine-wide shim no longer goes anywhere near this
 *  (it reads the forge-authored canonical descriptor instead — see renderDescriptorRead),
 *  because an sh line-matcher cannot replicate JSON.parse's semantics and a manifest that
 *  passed promotion's parser could hand a different value to this one. The entry does not
 *  have that exposure: it is GENERATED PER RELEASE by trusted Node, so its interpreter and
 *  its entry path are BAKED INTO ITS OWN TEXT (renderEntry) and are never read from the
 *  manifest at all. The single value it does read here is the release id — and trusted Node
 *  re-validates that against the parsed manifest after startup (src/cli/node-preflight.ts),
 *  so a divergent read is caught by the one parser that is authoritative rather than trusted
 *  on the strength of this reader agreeing with it. */
function renderManifestRead(manifestVar: string, keys: readonly string[]): string {
  const lines = [`while IFS= read -r __forge_ln; do`, `  case "$__forge_ln" in`];
  for (const key of keys) {
    lines.push(
      `  *\\"${key}\\":*)`,
      `    __forge_v=\${__forge_ln#*\\"${key}\\": \\"}`,
      `    __forge_${key}=\${__forge_v%%\\"*} ;;`,
    );
  }
  lines.push(`  esac`, `done < "$${manifestVar}"`);
  return lines.join("\n");
}

/** FG-571 (FG571-RI) — FAIL-CLOSED release identity, the second half of the contract.
 *
 *  Unsetting ambient FORGE_RELEASE_ID (renderEnvSanitizer) stops the spoof, but on its
 *  own it silently degrades a real release's provenance to "unknown" whenever the
 *  manifest read yields nothing — trading a spoofing bug for a correctness bug. So a
 *  stable release entry/shim must ALSO refuse to run when the selected release cannot
 *  state who it is: absent, malformed, or unreadable identity is a NAMED refusal, never
 *  null-and-continue and never the ambient value. A release that cannot state who it is
 *  does not run. (The dev entry, bin/forge-dev, has no manifest — null is the honest
 *  answer there, per FG-569's "not recorded, never manufactured".)
 *
 *  The refusal follows FG-570's node-preflight style: what was wrong, WHERE (the manifest
 *  path), what was running, and how to fix it. `context` names the launcher so the
 *  operator knows which of the two surfaces refused. */
function renderIdentityGuard(manifestVar: string, context: string): string {
  const fail = (what: string, detail: string) =>
    [
      `    printf '%s\\n' "forge: refusing to run — ${what}." >&2`,
      `    printf '%s\\n' "  release manifest: $${manifestVar}" >&2`,
      `    printf '%s\\n' "  manifest id:      ${detail}" >&2`,
      `    printf '%s\\n' "  running:          ${context}" >&2`,
      `    printf '%s\\n' "A release's identity comes solely from its own manifest — forge never reads it from" >&2`,
      `    printf '%s\\n' "the ambient environment, so it cannot fall back to a caller-supplied value, and it" >&2`,
      `    printf '%s\\n' "will not record a release as 'unknown'. A release that cannot state who it is does" >&2`,
      `    printf '%s\\n' "not run." >&2`,
      `    printf '%s\\n' "Fix: promote a release built by \\\`forge release build\\\` (it records \\\`id\\\`), or roll" >&2`,
      `    printf '%s\\n' "back to the previous release: \\\`forge release rollback\\\`." >&2`,
      `    exit 1`,
    ].join("\n");
  return [
    "# FG-571 (FG571-RI): identity is FAIL-CLOSED — unreadable, absent, or malformed all refuse.",
    `if [ ! -r "$${manifestVar}" ]; then`,
    fail("this release's manifest is unreadable", "(the manifest could not be read)"),
    `fi`,
    renderManifestRead(manifestVar, ["id"]),
    // A quoted id is a plain token. Anything else — an unquoted/numeric/object value, a
    // truncated line, JSON that is not a manifest at all — leaves junk (spaces, braces,
    // quotes) or nothing here, and is MALFORMED, not something to guess at.
    `case $__forge_id in`,
    `"")`,
    fail("this release's manifest states no identity", "(missing)"),
    `  ;;`,
    `*[!A-Za-z0-9._-]*)`,
    fail("this release's manifest states a malformed identity", '$__forge_id'),
    `  ;;`,
    `esac`,
    `FORGE_RELEASE_ID=$__forge_id`,
    `export FORGE_RELEASE_ID`,
  ].join("\n");
}

/** The sh entry: resolve the release root from the script's own path (no PATH,
 *  no node needed to bootstrap), then exec the PINNED absolute interpreter with
 *  tsx loaded in-process. ONE process; it is the one that loads the binding. */
export function renderEntry(interpreter: string): string {
  // The interpreter is an absolute filesystem path captured from process.execPath;
  // single-quote it so a space in the path can't split the exec argv.
  const q = `'${interpreter.replaceAll("'", `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# FG-569 release entry — exec the pinned interpreter, tsx in-process, ONE process.",
    "# FG-571: sanitized env + fail-closed release identity, sharing ONE renderer with the",
    "# machine-wide shim (renderShim) so the hostile-caller surface cannot drift.",
    renderEnvSanitizer(),
    "# Works under a hostile PATH (incl. NO node at all): the interpreter path is",
    "# absolute AND (for a direct invocation) the release dir is resolved with shell",
    "# builtins only (no dirname/pwd-on-PATH external), so nothing consults PATH.",
    "#",
    "# A promoted release is reached via a symlink (current/PATH shim), so canonicalize",
    "# $0 through symlinks before deriving the release root — else $here/src would",
    "# resolve next to the symlink, not the release. readlink is NOT a shell builtin: it",
    "# is resolved through PATH, so a symlinked entry under a node-free PATH could not",
    "# find it (the exact case a promotion symlink hits). Canonicalize instead with the",
    "# PINNED interpreter — an ABSOLUTE path, no PATH lookup, the one process the entry",
    "# already depends on being present — whose realpathSync resolves the whole symlink",
    "# chain (and any relative target) in a single call. The `-- \"$p\"` stops node from",
    "# reading a leading-dash link name as one of its own options. This runs ONLY when $0",
    "# is a symlink, so a DIRECT invocation stays a single node exec.",
    `p=$0`,
    `case "$p" in */*) ;; *) p=$(command -v "$p") ;; esac`,
    `if [ -L "$p" ]; then`,
    `  p=$(${q} -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' -- "$p")`,
    `fi`,
    `case "$p" in */*) d=\${p%/*} ;; *) d=. ;; esac`,
    // POSIX gives the `cd` builtin no `--` operand separator (unlike node's -e -- above),
    // so a strict /bin/sh reads `cd -- "$d"` as a cd to the directory named `--` and every
    // direct invocation fails before the pinned interpreter is reached. Guard a leading-dash
    // dir name with a `./` prefix instead — portable across dash/ash/bash.
    `case $d in -*) d=./$d ;; esac`,
    // FG-571: `cd -P` (physical), not the default logical cd. A promoted release is
    // reached as `$FORGE_HOME/current/forge` — $0 is then NOT itself a symlink (the -L
    // branch above does not fire), but a symlink COMPONENT is in its path. A logical cd
    // would leave $here as `.../current`, so the manifest, the interpreter pin baked into
    // THIS script, and the source tree would each be re-resolved through the pointer at a
    // different instant — a swap landing between them yields a MIXED closure (F26). `-P`
    // canonicalizes the component chain in the cd builtin itself, so $here is the release's
    // PHYSICAL path and every later read comes from that ONE resolution. Builtin: no PATH.
    `here=$(CDPATH= cd -P "$d" && pwd)`,
    "",
    "# FG-569 (R2) / FG-571 (FG571-RI): export this release's OWN id, read from its manifest",
    "# with shell builtins only (no sed/grep/node), so a node-free PATH still touches no",
    "# external. Every process the release starts — notably the `forge launch` exit-recorder",
    "# — then records this release's provenance. FG-571 makes it FAIL-CLOSED: the ambient",
    "# value is unset above and an absent/malformed/unreadable identity REFUSES rather than",
    "# degrading to unknown. bin/forge-dev has no manifest and is a separate file, so a dev",
    "# launch stays null — the honest answer there.",
    `__forge_m=$here/${RELEASE_MANIFEST_NAME}`,
    renderIdentityGuard("__forge_m", "the forge release entry at $here"),
    "",
    `exec ${q} --import "$here/${RELEASE_LOADER_NAME}" "$here/${RELEASE_ENTRY_SOURCE}" "$@"`,
    "",
  ].join("\n");
}

export const SHIM_NAME = "forge";

/** A fail-closed shim refusal, in the FG-570 style: what was wrong, WHERE, what was
 *  running, and how to fix it. `indent` matches the block the refusal is emitted from so the
 *  generated script stays readable. */
function shRefuse(what: string, detail: readonly string[], body: readonly string[], indent = "  "): string {
  return [
    `${indent}printf '%s\\n' "forge: refusing to run — ${what}." >&2`,
    ...detail.map((d) => `${indent}printf '%s\\n' "${d}" >&2`),
    `${indent}printf '%s\\n' "  running:            the machine-wide forge shim" >&2`,
    ...body.map((b) => `${indent}printf '%s\\n' "${b}" >&2`),
    `${indent}exit 1`,
  ].join("\n");
}

/** FG-571 — the shim's CANONICAL-DESCRIPTOR reader. NOT a parser: forge authors the
 *  descriptor in trusted Node, so it is exact by construction and this VALIDATES it.
 *
 *  The format is trivially and unambiguously readable in POSIX sh — one field per line,
 *  fixed order, fixed prefix — which is the whole reason it exists. Fixed order plus an
 *  exact field count makes a duplicate, an extra, and a missing field all structurally
 *  impossible to sneak past: line 1 must be `interpreter <v>` and line 2 must be
 *  `release <v>`, and a third line is refused outright.
 *
 *  Values are consumed as DATA through QUOTED shell variables and never evaluated as shell
 *  syntax: there is no `eval`, no unquoted expansion, and no command substitution reachable
 *  from a value. The character-set checks below are belt-and-braces on top of that — a value
 *  could not become syntax even without them.
 *
 *  `done < "$file"` redirects rather than pipes, so the loop runs in THIS shell: the field
 *  variables survive it and an `exit` inside it actually exits. */
function renderDescriptorRead(dirVar: string): string {
  const missing = shRefuse(
    "this release carries no canonical execution descriptor",
    [`  release unit:       $${dirVar}`, `  expected descriptor: $__forge_d`],
    [
      "The shim execs only what forge itself authored into the release unit at promotion — it does",
      "not parse the release's manifest, because an sh reader and forge's JSON parser can disagree",
      "about what a manifest says, and the shim would then exec something promotion never validated.",
      "A release promoted by an older forge carries no descriptor.",
      "Fix: re-promote this release — \\`forge release promote <dir|id>\\` — or \\`forge release rollback\\`.",
    ],
  );
  const malformed = (what: string) =>
    shRefuse(
      `this release's execution descriptor is malformed — ${what}`,
      [`      descriptor: $__forge_d`],
      [
        "Forge authors this file itself, with exactly two fields in a fixed order, so a descriptor",
        "that does not have that exact shape was not written by a forge promotion.",
        "Fix: re-promote this release, or \\`forge release rollback\\` to the previous release.",
      ],
      "      ",
    );
  return [
    `__forge_d=$${dirVar}/${RELEASE_EXEC_NAME}`,
    `if [ ! -r "$__forge_d" ]; then`,
    missing,
    `fi`,
    `__forge_n=0`,
    `__forge_interpreter=`,
    `__forge_release=`,
    `while IFS= read -r __forge_ln; do`,
    `  __forge_n=$((__forge_n + 1))`,
    `  case $__forge_n in`,
    `  1)`,
    `    case $__forge_ln in`,
    `      "${EXEC_FIELDS[0]} "?*) __forge_interpreter=\${__forge_ln#${EXEC_FIELDS[0]} } ;;`,
    `      *)`,
    malformed(`field 1 is not a non-empty \\\`${EXEC_FIELDS[0]}\\\` field`),
    `        ;;`,
    `    esac ;;`,
    `  2)`,
    `    case $__forge_ln in`,
    `      "${EXEC_FIELDS[1]} "?*) __forge_release=\${__forge_ln#${EXEC_FIELDS[1]} } ;;`,
    `      *)`,
    malformed(`field 2 is not a non-empty \\\`${EXEC_FIELDS[1]}\\\` field`),
    `        ;;`,
    `    esac ;;`,
    `  *)`,
    malformed("it carries more than the two permitted fields"),
    `    ;;`,
    `  esac`,
    `done < "$__forge_d"`,
    `if [ "$__forge_n" -ne ${EXEC_FIELDS.length} ]; then`,
    shRefuse(
      `this release's execution descriptor states the wrong number of fields`,
      [`  descriptor: $__forge_d`, `  fields:     $__forge_n (exactly ${EXEC_FIELDS.length} are required)`],
      ["Fix: re-promote this release, or \\`forge release rollback\\` to the previous release."],
    ),
    `fi`,
  ].join("\n");
}

/** FG-571 (OQ-6) — THE NEAR-FROZEN /bin/sh PATH SHIM: the machine-wide `forge`.
 *
 *  Its whole contract, and nothing more: **sanitize env → resolve `current` → read the
 *  canonical descriptor → exec the pinned absolute interpreter against the release entry.**
 *  It is
 *  deliberately OUTSIDE the release closure — inside, a bad promotion would brick `forge`
 *  itself and rollback-via-forge would be impossible. The honest cost is that shim changes
 *  are NOT atomic with a release, which is exactly why the contract is kept this small and
 *  why changing it is an install-level breaking change gated behind an explicit
 *  `forge release install-shim`, never a side effect of a promotion.
 *
 *  It consults NO PATH. `/bin/sh` is the only interpreter whose absolute path is
 *  guaranteed without a PATH lookup — that is the entire point, and what lets F29 pass in
 *  its sharpest form (a shell with NO node on PATH at all, or one where PATH resolves an
 *  INCOMPATIBLE node first). Everything it uses is a shell builtin (`unset`, `cd`, `pwd`,
 *  `read`, `case`, `printf`, `exec`); it never reaches for node, readlink, sed, or grep.
 *
 *  ONE resolution of `current`, via the `cd -P` builtin: $here is the release's PHYSICAL
 *  path, and the identity, the interpreter, and the entry are ALL read from that single
 *  resolution. A promotion landing at any instant therefore yields release A entirely or
 *  release B entirely — never A's interpreter against B's source (F26: no invocation may
 *  observe a mixed source/runtime closure). Reading each through `$FORGE_HOME/current`
 *  separately would re-resolve the pointer three times and could mix them.
 *
 *  FORGE_HOME is read at RUNTIME, never baked: setting it fully isolates the shim onto a
 *  disposable forge home, which is what keeps a test off the operator's real control plane. */
export function renderShim(): string {
  return [
    "#!/bin/sh",
    "# forge — the machine-wide PATH shim (FG-571 / FG-553 Child 4). NEAR-FROZEN:",
    "# sanitize env -> resolve `current` -> read the canonical execution descriptor -> exec",
    "# the pinned absolute interpreter against the release entry. It never reads the release's",
    "# JSON manifest. Nothing more. Installed ONLY by an explicit",
    "# `forge release install-shim --prefix <dir>`; a promotion never rewrites it.",
    "#",
    "# Shell builtins only — no node, no readlink, no sed/grep on PATH. This runs correctly",
    "# from a shell with NO node on PATH at all, and from one whose PATH resolves an",
    "# INCOMPATIBLE node first: PATH is never consulted for anything.",
    renderEnvSanitizer(),
    "",
    "# ONE physical resolution of `current` (the `cd -P` builtin canonicalizes the symlink",
    "# chain); identity, interpreter, and entry all come from THIS $here. A promotion landing",
    "# mid-invocation therefore yields one release entirely, never a mixed closure (F26).",
    `__forge_home=\${FORGE_HOME:-$HOME/.forge}`,
    `__forge_current=$__forge_home/current`,
    `here=$(CDPATH= cd -P "$__forge_current" 2>/dev/null && pwd)`,
    `if [ -z "$here" ]; then`,
    `  printf '%s\\n' "forge: refusing to run — no forge release is selected." >&2`,
    `  printf '%s\\n' "  current pointer: $__forge_current" >&2`,
    `  printf '%s\\n' "  running:         the machine-wide forge shim" >&2`,
    `  printf '%s\\n' "The shim execs whichever release \\\`current\\\` selects; it does not fall back to a" >&2`,
    `  printf '%s\\n' "source checkout or to a node on PATH, because either would run code this shim" >&2`,
    `  printf '%s\\n' "cannot vouch for." >&2`,
    `  printf '%s\\n' "Fix: promote a release — \\\`forge release promote <dir|id>\\\` — or point FORGE_HOME at" >&2`,
    `  printf '%s\\n' "the forge home that holds it (currently $__forge_home)." >&2`,
    `  exit 1`,
    `fi`,
    "",
    "# THE ONLY FILE THIS SHIM READS inside the selected unit. It is FORGE-AUTHORED, in trusted",
    "# Node, at promotion, AFTER the unit's bytes were parsed and validated — so the shim",
    "# VALIDATES a known-exact shape rather than parsing caller-controlled bytes. The shim never",
    "# reads the release's JSON manifest: an sh line-reader and JSON.parse can disagree about what",
    "# the same manifest says (duplicate keys, escapes, embedded newlines), and a candidate that",
    "# PASSED promotion could then hand this shim a different interpreter to exec. One parser",
    "# (Node), one author (forge): divergence is impossible by construction, not by upkeep.",
    renderDescriptorRead("here"),
    "",
    "# The interpreter is PINNED BY THE DESCRIPTOR — an identity promotion already validated by",
    "# EXECUTION and proved to live in the immutable interpreter store. It is never an arbitrary",
    "# absolute path a raw manifest named, and never resolved from PATH: the shim outlives the",
    "# releases it selects, so baking an interpreter into it would reintroduce the very drift the",
    "# per-release pin exists to prevent.",
    `case $__forge_interpreter in`,
    `  /*) ;;`,
    `  *)`,
    shRefuse(
      "this release's execution descriptor does not name an absolute interpreter",
      [`  descriptor:  $__forge_d`, `  interpreter: $__forge_interpreter`],
      [
        "The shim never resolves an interpreter from PATH — a release names the absolute interpreter",
        "its own native binding was built against, or it does not run.",
        "Fix: re-promote this release, or \\`forge release rollback\\` to the previous release.",
      ],
      "    ",
    ),
    `    ;;`,
    `esac`,
    "# RESTRICTED CHARACTER SET, fail-closed. The values below are consumed as DATA through quoted",
    "# variables and are never evaluated as shell syntax — there is no eval, no unquoted expansion,",
    "# and no command substitution reachable from either one — so this is a second, independent",
    "# barrier rather than the only one. Nothing outside the set is admitted: no quote, no",
    "# backslash, no `$`, no backtick, no whitespace, no glob or redirection metacharacter.",
    `case $__forge_interpreter in`,
    `  *[!${SH_INTERPRETER_CHARSET}]*)`,
    shRefuse(
      "this release's execution descriptor names an interpreter holding a disallowed character",
      [`  descriptor:  $__forge_d`, `  interpreter: $__forge_interpreter`, `  permitted:   [${SH_INTERPRETER_CHARSET}]`],
      ["Fix: re-promote this release, or \\`forge release rollback\\` to the previous release."],
      "    ",
    ),
    `    ;;`,
    `esac`,
    `case $__forge_release in`,
    `  *[!${SH_ID_CHARSET}]*)`,
    shRefuse(
      "this release's execution descriptor states a malformed identity",
      [`  descriptor: $__forge_d`, `  release id: $__forge_release`, `  permitted:  [${SH_ID_CHARSET}]`],
      ["Fix: re-promote this release, or \\`forge release rollback\\` to the previous release."],
      "    ",
    ),
    `    ;;`,
    `esac`,
    `if [ ! -x "$__forge_interpreter" ]; then`,
    shRefuse(
      "this release's pinned interpreter is missing",
      [`  descriptor:  $__forge_d`, `  interpreter: $__forge_interpreter (not executable)`],
      [
        "This release's native binding loads under that interpreter only, so the shim will not",
        "substitute another one.",
        "Fix: reinstall the interpreter, or \\`forge release rollback\\` to the previous release.",
      ],
    ),
    `fi`,
    "",
    "# FG-571 (FG571-RI) — release identity, exported from the DESCRIPTOR. Fail-closed: the ambient",
    "# FORGE_RELEASE_ID was unset above, and a descriptor that cannot state a well-formed identity",
    "# refused before reaching here, so this is never a caller value and never 'unknown'. Trusted",
    "# Node RE-VALIDATES it after startup against forge-release.json — which stays the authority on",
    "# what the release IS — and refuses by name on a mismatch (see src/cli/node-preflight.ts).",
    `FORGE_RELEASE_ID=$__forge_release`,
    `export FORGE_RELEASE_ID`,
    "",
    "# FG-571 — the descriptor's INTERPRETER, carried to trusted Node for the same reason the id",
    "# is: the descriptor is what the shim EXECS, and forge-release.json is the authority on what",
    "# this release IS. Carrying only the id let a descriptor name interpreter A while the manifest",
    "# named B with nothing to catch it — a matching id was enough to pass. Node re-checks BOTH",
    "# against the parsed manifest after startup and refuses by name on either mismatch. The",
    "# ambient value was unset above, so this is never a caller's.",
    `FORGE_RELEASE_INTERPRETER=$__forge_interpreter`,
    `export FORGE_RELEASE_INTERPRETER`,
    "",
    "# The entry and the loader are FIXED SCHEMA CONSTANTS baked into this shim at render time —",
    "# NOT descriptor fields, and never read from the selected unit. A release closes over exactly",
    "# one entry point and one loader, so there is no supported case for either to vary; making",
    "# them dynamic input would be strictly more machinery admitting strictly more inputs, and it",
    "# is precisely how a manifest naming `../../outside.mjs` used to reach this exec. Baked in,",
    "# nothing on disk can redirect what runs — the entry-containment question does not arise here",
    "# at all, and promotion separately proves the fixed entry resolves to a regular file that is",
    "# physically inside the unit.",
    "#",
    "# exec, not spawn: ONE process, and it is the one that loads the native binding — its",
    "# process.execPath IS the control runtime (R1), self-evidencing.",
    `exec "$__forge_interpreter" --import "$here/${RELEASE_LOADER_NAME}" "$here/${RELEASE_ENTRY_SOURCE}" "$@"`,
    "",
  ].join("\n");
}

function gitCommit(sourceRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
  } catch (e) {
    throw new Error(`forge release: cannot read the commit SHA at ${sourceRoot} (not a git repo?) — ${(e as Error).message}`);
  }
}

/** WHO built this release — the trusted builder identity recorded on the manifest as
 *  `builderCommit`, distinct from the --source `commit`. There are two builder kinds,
 *  distinguished by whether THIS module runs from inside an immutable release:
 *
 *   - A RELEASE builder (a release manifest resolves for this module's location): its
 *     own tree has NO `.git` — an immutable release is a COPY, not a git checkout — so
 *     its trusted identity is its OWN release manifest's `commit`, read here. It must
 *     NOT call findGitRoot / selectLockfile / the dirty-check against the release tree:
 *     there is nothing to commit or stash in an immutable release, and findGitRoot would
 *     fall back to the release's src/v2 dir (no lockfile there → a false torn-closure
 *     refusal). This is the FG-569 fix that lets a built release build its successor.
 *   - A DEVELOPMENT builder (no release manifest resolves): derive and verify identity
 *     from its Git checkout — findGitRoot + the builder dirty-check + gitCommit. On a
 *     self-build (builder root IS the --source checkout) the two commits are equal, so
 *     `sourceCommit` is reused directly.
 *
 *  Never manufactured from --source: the builder identity is WHO BUILT this release
 *  (e.g. release A's own commit), recorded SEPARATELY from the successor's source
 *  `commit`. */
function resolveBuilderCommit(sourceRoot: string, sourceCommit: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const runningRelease = readReleaseManifest(moduleDir);
  if (runningRelease) return runningRelease.manifest.commit;

  const bRoot = findGitRoot(moduleDir);
  if (bRoot === sourceRoot) return sourceCommit;
  // The builder contributes only the generated entry/loader bytes (from src/), so bind
  // its own src/package.json/lockfile — the assets come from --source, checked above.
  const builderLockfile = selectLockfile(bRoot);
  assertCommitDescribesTree(bRoot, ["src", "package.json", builderLockfile], "builder");
  return gitCommit(bRoot);
}

/** Refuse to build when ANY commit-bound SHIPPED source path of `root` is dirty
 *  relative to HEAD, so the recorded commit can never lie about the copied bytes
 *  (FG-569 GAP 2, extended by Resolution B to EVERY copied source asset). `paths` is
 *  the exact set copied under the commit's identity — src/, package.json, the selected
 *  lockfile, AND the bundled asset dirs (seeds/, scripts/, docker/). A dirty seed OR
 *  hook OR docker file therefore refuses the build for the same reason a dirty src/
 *  does: the manifest commit would not describe the shipped bytes. node_modules is NOT
 *  here — it is install OUTPUT, bound to the lockfile separately
 *  (assertShippedClosureMatchesLockfile), not part of the commit's source identity.
 *  `label` names which checkout (source / builder) so the refusal is actionable. */
function assertCommitDescribesTree(root: string, paths: readonly string[], label: string): void {
  let porcelain: string;
  try {
    porcelain = execFileSync("git", ["status", "--porcelain", "--", ...paths], { cwd: root, encoding: "utf8" });
  } catch (e) {
    throw new Error(`forge release: cannot check the ${label} tree at ${root} for uncommitted changes (not a git repo?) — ${(e as Error).message}`);
  }
  if (porcelain.trim() !== "") {
    throw new Error(`forge release: refusing to build a release from a dirty ${label} at ${root} — one of the shipped source paths (${paths.join(", ")}) has uncommitted changes relative to HEAD, so the manifest commit would not describe the shipped bytes. Commit or stash these changes, then rebuild:\n${porcelain.trimEnd()}`);
  }
}

const LOCKFILE_PRECEDENCE = ["npm-shrinkwrap.json", "package-lock.json"] as const;

/** FG-569 (Finding 4): the ONE effective lockfile, selected the way npm selects it —
 *  npm-shrinkwrap.json takes precedence over package-lock.json when both are present.
 *  The copy, the byte-binding (assertShippedClosureMatchesLockfile), and the manifest
 *  identity (lockfileIdentity) all read THIS one selection, so no part of the binding
 *  path hardcodes a lockfile name. Throws if neither exists. */
function selectLockfile(root: string): string {
  for (const name of LOCKFILE_PRECEDENCE) {
    if (existsSync(join(root, name))) return name;
  }
  throw new Error(`forge release: no lockfile (npm-shrinkwrap.json or package-lock.json) at ${root} — a release must pin an exact dependency closure`);
}

/** The lockfile identity recorded in the manifest: the SELECTED lockfile's name and a
 *  sha256 of its bytes. The caller passes the single selection so the manifest binds
 *  the same lockfile the copy and the byte-binding used. */
function lockfileIdentity(root: string, name: string): { name: string; sha256: string } {
  return { name, sha256: createHash("sha256").update(readFileSync(join(root, name))).digest("hex") };
}

/** Load the SOURCE ROOT's compiled better-sqlite3 under the building interpreter,
 *  and confirm the tsx loader the entry depends on is installed. This is the
 *  pre-copy gate: a missing / corrupt / ABI-mismatched binding (or a missing tsx)
 *  throws here, BEFORE any copy, so a torn closure never becomes a release. The
 *  COPIED closure is validated again post-copy under the pinned interpreter — see
 *  assertReleaseCloses (the manifest must describe the SHIPPED closure, not the
 *  source at build time). */
export function assertClosureLoads(sourceRoot: string): void {
  const bindingPath = join(sourceRoot, RELEASE_BINDING_REL);
  if (!existsSync(bindingPath)) {
    throw new Error(`forge release: torn closure — the compiled native binding is missing at ${bindingPath}. Run npm install/rebuild, then rebuild the release.`);
  }
  let Database: new (path: string) => { close(): void };
  try {
    const require = createRequire(join(sourceRoot, "package.json"));
    Database = require("better-sqlite3") as typeof Database;
  } catch (e) {
    throw new Error(`forge release: torn closure — cannot load better-sqlite3 from ${join(sourceRoot, "node_modules")} under this interpreter (${process.execPath}, ABI ${process.versions.modules}): ${(e as Error).message}`);
  }
  let db: { close(): void } | undefined;
  try {
    db = new Database(":memory:");
  } catch (e) {
    throw new Error(`forge release: torn closure — the native binding at ${bindingPath} did not load (corrupt or ABI-mismatched) under this interpreter (ABI ${process.versions.modules}): ${(e as Error).message}`);
  } finally {
    db?.close();
  }
  // FIX 5: the release entry runs `node --import forge-loader.mjs` and the shim
  // does `import "tsx"`. If tsx is absent the entry can't even start, gate green
  // or not — so require its presence before we bother copying the closure.
  if (!existsSync(join(sourceRoot, "node_modules", "tsx", "package.json"))) {
    throw new Error(`forge release: the tsx loader is not installed at ${join(sourceRoot, "node_modules", "tsx")} — the release entry (node --import forge-loader.mjs) could not start. Run npm install, then rebuild the release.`);
  }
}

/** Validate the COPIED release closure by RUNNING it under the pinned interpreter
 *  — the release's actual runtime, a fresh process (no in-process double-load of
 *  the native addon). Proves two things the source pre-check cannot, because it
 *  exercises the shipped copy exactly as the entry will:
 *   - FIX 5: the tsx loader shim actually loads (`node --import <loader> -e ""`),
 *   - FIX 4: better-sqlite3 loads from the RELEASE's own node_modules and opens.
 *  A copy that corrupts the binding, drops tsx, or otherwise fails to run is
 *  caught here, before the release is published. */
export function assertReleaseCloses(releaseRoot: string, interpreter: string): void {
  const loader = join(releaseRoot, RELEASE_LOADER_NAME);
  // 1) tsx: the entry can't run at all if `import "tsx"` throws.
  try {
    execFileSync(interpreter, ["--import", loader, "-e", ""], { cwd: releaseRoot, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? (e as Error).message;
    throw new Error(`forge release: the COPIED closure's tsx loader did not run under the pinned interpreter (${interpreter}) — the release would not start: ${stderr.trim()}`);
  }
  // 2) better-sqlite3: load the RELEASE's own binding and open an in-memory DB.
  try {
    execFileSync(interpreter, ["--import", loader, "-e", "new (require('better-sqlite3'))(':memory:').close()"], { cwd: releaseRoot, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? (e as Error).message;
    throw new Error(`forge release: torn closure — the COPIED better-sqlite3 binding did not load under the pinned interpreter (${interpreter}, ABI ${process.versions.modules}): ${stderr.trim()}`);
  }
}

type LockPackage = { resolved?: string; integrity?: string; link?: boolean; hasInstallScript?: boolean };

/** The npm content-addressable cache holds every tarball the lockfile pins, keyed
 *  BY its integrity — npm verifies the bytes against that integrity on write, so a
 *  cache hit IS the authentic, lockfile-pinned tarball. Derive the store path the
 *  way cacache does: hex-encode the digest, split 2/2/rest. Returns null on a miss
 *  (the tarball for that integrity is not local). */
function cacheTarballPath(cacheDir: string, integrity: string): string | null {
  for (const entry of integrity.trim().split(/\s+/)) {
    const dash = entry.indexOf("-");
    if (dash < 0) continue;
    const algo = entry.slice(0, dash);
    const hex = Buffer.from(entry.slice(dash + 1), "base64").toString("hex");
    const p = join(cacheDir, "_cacache", "content-v2", algo, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    if (existsSync(p)) return p;
  }
  return null;
}

/** Read a gzipped npm package tarball into a map of regular-file entry -> bytes.
 *  A minimal ustar reader (no dependency): honours the PAX 'x' and GNU 'L' long-
 *  name extensions that appear when a path exceeds the 100+155-char header fields
 *  (some deep dependency trees hit this), so every file name is recovered exactly. */
function readTarFiles(tarball: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let longName: string | null = null;
  let paxPath: string | null = null;
  let off = 0;
  while (off + 512 <= tarball.length) {
    const hdr = tarball.subarray(off, off + 512);
    off += 512;
    if (hdr.every((b) => b === 0)) break;
    const field = (start: number, len: number): string => hdr.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
    let name = field(0, 100);
    const prefix = field(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(field(124, 12).trim() || "0", 8) || 0;
    const type = String.fromCharCode(hdr[156]!);
    const data = tarball.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"));
      if (type === "x" && m) paxPath = m[1]!;
      continue;
    }
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    const entryName = paxPath ?? longName ?? name;
    paxPath = null;
    longName = null;
    if (type === "0" || type === "\0" || type === "") files.set(entryName, Buffer.from(data));
  }
  return files;
}

/** BIND the SHIPPED closure to the lockfile (FG-569). Hashing the lockfile bytes
 *  proves only WHICH lockfile was copied, not that the installed tree MATCHES it —
 *  a content-mutated dependency with an unchanged lockfile slips through. This
 *  closes that hole: for every package the lockfile pins by `integrity` that is
 *  present in the shipped node_modules, compare each of its tarball's files, byte
 *  for byte, against the shipped file. The lockfile-pinned tarball comes from the
 *  npm content cache (keyed by integrity — the authentic bytes), so this ties the
 *  SHIPPED content to the lockfile, not merely the lockfile file to itself.
 *
 *  An install-script package (better-sqlite3, esbuild, sharp) is NOT skipped: the
 *  loop iterates the TARBALL's files and binds each, and a package's genuinely
 *  install-generated artifacts (the compiled better_sqlite3.node, a downloaded
 *  platform binary) are naturally unbound because they are not tarball entries —
 *  so an install-script package's tarball-owned SOURCE (lib/index.js, package.json)
 *  is still byte-bound, which is where a supply-chain tamper would hide. Verified
 *  against this closure: better-sqlite3's 49 and sharp's 33 tarball files are all
 *  byte-identical on disk; esbuild rewrites exactly one tarball-owned file (see
 *  INSTALL_REWRITTEN_ALLOWANCE below).
 *
 *  Carve-outs, each principled — NOT a weakening to "just tsx + better-sqlite3":
 *   - Packages absent from node_modules (optional / other-platform deps like
 *     @esbuild/darwin-*) are not shipped, so nothing to bind.
 *   - `link` (workspace/local link — no tarball) and `!integrity` (nothing to
 *     verify against) are the ONLY package-level skips. */

// esbuild's postinstall (install.js → maybeOptimizePackage) renames the platform-
// native binary over this one tarball-owned placeholder, so its on-disk bytes
// legitimately differ from the tarball BY DESIGN — like a generated artifact, except
// it happens to share a path the tarball also ships. It is the ONLY tarball-owned
// file any install-script package in this closure rewrites. The allowance is EXACTLY
// this package + path — never a directory or glob — so every other file in esbuild
// (and everywhere else) stays byte-bound.
const INSTALL_REWRITTEN_ALLOWANCE = new Set<string>(["node_modules/esbuild/bin/esbuild"]);

export function assertShippedClosureMatchesLockfile(root: string, lockfileName: string): void {
  const lockPath = join(root, lockfileName);
  if (!existsSync(lockPath)) {
    throw new Error(`forge release: no ${lockfileName} at ${root} — cannot bind the shipped closure to a lockfile`);
  }
  const cacheDir = execFileSync("npm", ["config", "get", "cache"], { cwd: root, encoding: "utf8" }).trim();
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages?: Record<string, LockPackage> };
  const packages = lock.packages ?? {};

  for (const [key, meta] of Object.entries(packages)) {
    if (!key.startsWith("node_modules/")) continue; // the "" root + workspace entries
    if (meta.link || !meta.integrity) continue;
    const pkgDir = join(root, key);
    if (!existsSync(pkgDir)) continue; // not shipped (optional / other-platform)

    const tarballPath = cacheTarballPath(cacheDir, meta.integrity);
    if (!tarballPath) {
      // Fail closed: without the authentic tarball we cannot prove the shipped
      // bytes match the lockfile. A warm cache is the norm right after install; a
      // miss means the cache was cleared — repopulate it rather than ship unbound.
      throw new Error(`forge release: cannot bind ${key} to the lockfile — its tarball (integrity ${meta.integrity}) is not in the npm cache at ${cacheDir}. Run 'npm ci' to repopulate the cache, then rebuild the release.`);
    }
    const tarFiles = readTarFiles(gunzipSync(readFileSync(tarballPath)));
    for (const [entryName, content] of tarFiles) {
      // npm strips the tarball's single top-level dir (usually `package/`, but
      // e.g. `node v22.19/` for @types/node) on extract — strip the first segment.
      const rel = entryName.replace(/^[^/]*\//, "");
      if (!rel || rel.endsWith("/")) continue;
      if (INSTALL_REWRITTEN_ALLOWANCE.has(`${key}/${rel}`)) continue;
      const shipped = join(pkgDir, rel);
      if (!existsSync(shipped)) {
        throw new Error(`forge release: shipped closure does not match the lockfile — ${key}/${rel} is pinned by package-lock.json but MISSING from the shipped node_modules. The installed tree is incomplete or was tampered; refusing to ship.`);
      }
      if (Buffer.compare(readFileSync(shipped), content) !== 0) {
        throw new Error(`forge release: shipped closure does not match the lockfile — ${key}/${rel} differs from the bytes pinned by package-lock.json (integrity ${meta.integrity}). A dependency was modified after install; refusing to ship a closure that does not match its lockfile.`);
      }
    }
  }
}

export type BuildReleaseOptions = {
  sourceRoot: string;
  outDir: string;
  /** The forge home whose INTERPRETER STORE this release's interpreter is installed into
   *  and pinned from (default FORGE_HOME). Threaded rather than hardcoded for the same
   *  reason every promotion path is: it is what keeps a test that builds a release off the
   *  operator's real ~/.forge/interpreters. */
  home?: string;
  now?: Date;
  rand?: string;
  // Test seam: fires AFTER the up-front dirty-check + commit capture but BEFORE the committed
  // snapshot is materialized, so a test can dirty the LIVE working tree inside the build window
  // and prove the snapshot copy still ships the COMMITTED bytes regardless. Never set in
  // production. (The build copies git-tracked bytes from the recorded commit, not the live
  // tree, so a concurrent live edit cannot leak in — there is nothing here to refuse.)
  onBeforeSnapshot?: () => void;
};

export type BuildReleaseResult = {
  manifest: ReleaseManifest;
  releaseDir: string;
  entryPath: string;
};

/** Replace every symlink under `dir`, in place, with a real copy of its target so
 *  the release carries actual bytes and no link escapes the closure. Needed because
 *  cpSync's `dereference` follows only the top-level path, leaving nested links
 *  (an npm-linked dependency, a `.bin` entry) pointing outside the tree. A broken
 *  link resolves nowhere and throws here — the correct torn-closure refusal rather
 *  than a dangling link shipped into a "self-contained" release. */
function dereferenceSymlinks(dir: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      const target = realpathSync(p);
      rmSync(p, { recursive: true, force: true });
      cpSync(target, p, { recursive: true, dereference: true });
      // The copied target may itself hold nested links — dereference those too.
      if (statSync(p).isDirectory()) dereferenceSymlinks(p);
    } else if (ent.isDirectory()) {
      dereferenceSymlinks(p);
    }
  }
}

/** FG-569 (Finding 3): freeze the staging tree for shipping — recursively clear the
 *  write bits on every FILE **and DIRECTORY** so the released closure is immutable at
 *  rest. Read-only files alone are defeatable: a writable parent directory lets any
 *  file be unlink+recreated or a brand-new file injected, so the frozen files mean
 *  nothing. Directories keep their read + search/execute bits (the tree stays
 *  traversable and the release still runs) but lose write, so no entry can be added or
 *  removed. POST-ORDER — freeze a directory's children BEFORE the directory itself, so
 *  children can still be chmod'd while their parent is writable — and the passed-in ROOT
 *  is frozen last (top-level entries like forge-release.json must not be rm+recreatable).
 *  An existing-executable file stays executable (only write bits are cleared). Runs on
 *  the STAGING dir BEFORE the atomic rename, so the FINAL release path is never observed
 *  writable. (Symlinks are already dereferenced away, so every entry is a real file or
 *  directory.) A fully frozen tree cannot be rmSync'd without restoring write bits first
 *  — see thawReleaseTree, used on the build's own cleanup path.
 *
 *  Exported for FG-571's promotion path, which freezes the STAGED unit (bytes + generated
 *  descriptor) before the atomic rename that publishes it — the same "never observed
 *  writable at its final path" property this gives the builder.
 *
 *  IT NEVER FOLLOWS A SYMLINK, and refuses one by name instead. A freeze cannot protect a
 *  link's target: chmod through the link would clear the write bits on a file OUTSIDE the
 *  tree — which the attacker who planted the link still owns and can chmod straight back —
 *  while the link itself survives, still pointing out. The tree would then read as frozen
 *  and be trivially mutable. `ent.isDirectory()` is FALSE for a symlink-to-directory, so
 *  the link check must come first or a linked directory takes the file branch and chmods
 *  its target. Both callers hand this a tree that provably holds no links (buildRelease
 *  dereferences every one; promotion refuses a candidate carrying any), so reaching this
 *  refusal means an invariant upstream broke — fail closed rather than freeze a lie. */
export function freezeReleaseFiles(dir: string): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      throw new Error(
        `forge release: refusing to freeze — this release tree holds a symbolic link.\n` +
          `  release tree: ${dir}\n` +
          `  link:         ${p}\n` +
          `  expected:     a real file or directory (a release carries bytes, never links)\n` +
          `  found:        a symbolic link\n` +
          `Freezing clears the write bits so the released closure is immutable at rest, and a link's ` +
          `target lives outside the tree the freeze covers: chmod'ing THROUGH the link would leave the ` +
          `link in place, still pointing out, at a file whose owner can restore the write bits at will. ` +
          `A tree that cannot be frozen is not published.\n` +
          `Fix: rebuild with \`forge release build\` (it dereferences every link into real bytes).`,
      );
    }
    if (ent.isDirectory()) freezeReleaseFiles(p);
    else chmodSync(p, lstatSync(p).mode & ~0o222);
  }
  chmodSync(dir, lstatSync(dir).mode & ~0o222);
}

/** Restore write bits across a (possibly) frozen release tree so it can be removed:
 *  freezeReleaseFiles clears directory write bits, and a recursive unlink needs write
 *  on every parent directory. Used on the build's own cleanup path (a refused build
 *  must leave no release behind, even after the tree was frozen) and exported for tests
 *  that build a release and must tear it down. This is ONLY for removing a tree
 *  wholesale — never call it to weaken the freeze on a published release. Skips symlinks
 *  so it never chmods a link's out-of-tree target. */
export function thawReleaseTree(dir: string): void {
  chmodSync(dir, statSync(dir).mode | 0o200);
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) thawReleaseTree(p);
    else chmodSync(p, statSync(p).mode | 0o200);
  }
}

/** True when `child` is `parent` itself or a path nested under it. Both must already be
 *  resolved absolute paths. Used to keep the release out dir out of the source tree. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Build an immutable release closure from `sourceRoot` into `outDir`. Refuses a
 *  torn closure before writing anything. Builds into a sibling temp dir and
 *  renames into place, so an interrupted build never leaves a partial release. */
export function buildRelease(opts: BuildReleaseOptions): BuildReleaseResult {
  const sourceRoot = resolve(opts.sourceRoot);
  const outDir = resolve(opts.outDir);

  for (const rel of ["package.json", "src", "node_modules"]) {
    if (!existsSync(join(sourceRoot, rel))) {
      throw new Error(`forge release: ${sourceRoot} is not a buildable source root — missing ${rel}`);
    }
  }
  if (existsSync(outDir)) {
    throw new Error(`forge release: ${outDir} already exists — a release directory is immutable and never overwritten`);
  }
  // The out dir (and thus its sibling `.building-*` staging dir) must live OUTSIDE the
  // source tree: staging inside sourceRoot makes the staging dir part of the copy input,
  // so the recursive cpSync of src/ + node_modules/ would copy the growing staging tree
  // into itself. Refuse before anything is created.
  if (isWithin(sourceRoot, outDir)) {
    throw new Error(`forge release: --out ${outDir} is inside the source root ${sourceRoot} — the release (and its staging dir) must be built outside the source tree, or the copy would recurse into itself. Choose an --out path outside ${sourceRoot}.`);
  }

  // FG-569 (Finding 4): select the ONE effective lockfile up front (input validation)
  // and thread this single selection through copy, byte-binding, and manifest —
  // npm-shrinkwrap.json wins over package-lock.json; neither present is a clear error.
  const lockfileName = selectLockfile(sourceRoot);

  // Gate FIRST: a torn closure must be refused BEFORE any copy so no partial
  // release survives the refusal.
  assertClosureLoads(sourceRoot);

  // FG-569 (Resolution B): a SUPPORTED control command resolves these module-relative
  // to the release root (init → seeds/ + scripts/, doctor → seeds/ via seed-drift, etc.).
  // A missing one is a TORN CLOSURE — the release would ship a command that cannot find
  // its own assets — so REFUSE the build rather than optionally skip (the round-1
  // seeds?/scripts? glob was too loose). Checked AFTER the native-binding gate so a torn
  // binding is still reported as such; this is not a silent optional-skip either way.
  for (const rel of REQUIRED_ASSET_DIRS) {
    if (!existsSync(join(sourceRoot, rel))) {
      throw new Error(`forge release: torn closure — required asset directory '${rel}' is missing at ${join(sourceRoot, rel)}. A supported control-plane command resolves it module-relative to the release; a release without it ships a command that cannot find its own assets. Add ${rel}/ to the source, then rebuild.`);
    }
  }

  // FG-580 (Option A): a promoted release MUST provide a working `forge dashboard`, so the
  // dashboard bundle is MANDATORY — not presence-conditional. Every release closes over the
  // dashboard runtime (source, static client assets, VENDORED client libs, dashboard-relevant
  // deps), which is exactly why the manifest can always claim `selfContainedFor:
  // "control-plane+dashboard"` truthfully. A source WITHOUT a dashboard/ dir cannot produce
  // that closure, so the build REFUSES BY NAME here rather than emitting a control-plane-only
  // release whose manifest would falsely advertise a dashboard it does not carry. (The
  // alternative — making selfContainedFor conditional — was rejected: it permits a
  // dashboard-less promoted release, which contradicts the operator decision.) A source WITH
  // a dashboard/ that is INCOMPLETE — missing the runtime entry, tsconfig, a representative
  // static asset, a vendored client lib, or a dashboard-relevant dep — is a TORN closure,
  // refused BY NAME by assertDashboardClosure (before the git-archive of dashboard/ paths, so
  // a partial dashboard/ fails with an actionable message rather than a cryptic archive
  // pathspec error). The vendored-lib entries specifically red if a maintainer forgot to run
  // scripts/vendor-dashboard-libs.mjs — the offline-boot guarantee at build time.
  if (!existsSync(join(sourceRoot, "dashboard"))) {
    throw new Error(
      `forge release: refusing to build — the source at ${sourceRoot} has no dashboard/ workspace, but a promoted release MUST bundle a working \`forge dashboard\` (FG-580, Option A). The manifest's selfContainedFor is always "control-plane+dashboard"; a dashboard-less source cannot produce that closure, so the build is refused rather than shipping a manifest that claims a dashboard the release does not carry. Build from a source that includes dashboard/ and its vendored client libs (run scripts/vendor-dashboard-libs.mjs).`,
    );
  }
  assertDashboardClosure(sourceRoot);

  // FG-569 (GAP 2): bind the recorded commit(s) to the shipped bytes. Refuse a dirty
  // SOURCE (its src/+package.json+lockfile are what gets copied) so `commit` cannot
  // lie, and record the BUILDER's own identity separately — the entry/loader bytes are
  // generated by THIS forge, not by --source. When the running builder is itself a
  // RELEASE, its trusted identity is its OWN manifest's commit (a release has no .git);
  // on a dev self-build the builder IS the source checkout, so the two commits are equal.
  const now = opts.now ?? new Date();
  // The commit-bound, GIT-TRACKED source paths: src/, package.json, the selected lockfile,
  // AND every bundled asset dir. These ship from a COMMITTED SNAPSHOT of `commit` (below),
  // not the live tree. A dirty one still refuses the build up front — a fast, clear fail —
  // even though the snapshot copy no longer depends on the tree staying clean during the build.
  // FG-580: the dashboard is bundled unconditionally, so its tracked paths are always
  // commit-bound too — a dirty or absent tracked dashboard source/static/vendored asset
  // refuses the build BY NAME (assertCommitDescribesTree), so the manifest commit can never
  // describe dashboard bytes it did not produce. The mandatory dashboard/ gate above already
  // refused a dashboard-less source, so these pathspecs always match tracked files (git
  // archive fatals on a pathspec matching no tracked files).
  const gitTrackedPaths = ["src", "package.json", lockfileName, ...REQUIRED_ASSET_DIRS, ...DASHBOARD_TRACKED_PATHS];
  assertCommitDescribesTree(sourceRoot, gitTrackedPaths, "source");
  const commit = gitCommit(sourceRoot);
  const builderCommit = resolveBuilderCommit(sourceRoot, commit);
  const rand = opts.rand ?? Math.random().toString(36).slice(2, 8);
  const id = `release-${commit.slice(0, 7)}-${rand}`;

  // FG-571 — BIND THE INTERPRETER TO THE STORE, at the only moment a release's interpreter
  // reference is created. A release names an ABSOLUTE interpreter and execs it forever; if
  // that path is the building process.execPath (/usr/local/bin/node — a system/homebrew/nvm
  // node), it is a MUTABLE EXTERNAL artifact: a package upgrade rewrites it in place, and a
  // release that was validated at promotion then breaks — or silently changes — under the
  // processes already anchored to it. The store's contract is exactly the fix: immutable,
  // CONTENT-ADDRESSED (the key commits to the interpreter's own bytes), validated BY EXECUTION
  // before it is committed, retained while referenced, never replaced in place. So a release
  // pins the STORE's copy of its building interpreter, never the location that copy came from,
  // and promotion REQUIRES that (validateCandidate / isStoredInterpreter) rather than trusting
  // any absolute path.
  //
  // The pinned PATH is therefore also the release's content commitment to its interpreter — the
  // manifest needs no digest field of its own, and the manifest→exec boundary is unchanged.
  //
  // Runs BEFORE any copy, like the closure gate: an interpreter that cannot be committed to
  // the store is a refusal, not a half-built release. Re-installing an already-valid key is
  // a no-op, so a rebuild copies nothing — and a builder that is ITSELF a release already
  // runs from the store, so its execPath resolves to that same key.
  const interpreter = installInterpreter({
    home: opts.home,
    source: process.execPath,
    expected: { version: process.version, abi: process.versions.modules },
  }).path;

  const tmpDir = `${outDir}.building-${rand}`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  try {
    // FG-569 (TOCTOU, closed): materialize the GIT-TRACKED commit-bound paths from a
    // COMMITTED SNAPSHOT of `commit` — `git archive` reads the commit's objects, never the
    // working tree — and extract them straight into staging. The shipped git-tracked bytes are
    // therefore EXACTLY the commit's bytes BY CONSTRUCTION: a concurrent edit to the live
    // working tree during the build cannot leak into the closure (post-copy LIVE rechecks could
    // not close this — the bytes would already have been captured mid-edit). `src` + the bundled
    // asset dirs (seeds/, scripts/, docker/) resolve module-relative to the release root — all
    // REQUIRED (asserted above). `dashboard/` is a SEPARATE npm workspace but is now bundled
    // and commit-bound too (FG-580, Option A — DASHBOARD_TRACKED_PATHS), so `forge dashboard`
    // runs from the release. All these paths have tracked content in a real source, so a single
    // archive covers the whole commit-bound set.
    opts.onBeforeSnapshot?.();
    let archive: Buffer;
    try {
      archive = execFileSync("git", ["archive", "--format=tar", commit, "--", ...gitTrackedPaths], { cwd: sourceRoot, maxBuffer: 512 * 1024 * 1024 });
    } catch (e) {
      throw new Error(`forge release: cannot materialize the committed snapshot (${gitTrackedPaths.join(", ")}) at ${commit.slice(0, 7)} from ${sourceRoot} — ${(e as Error).message}`);
    }
    execFileSync("tar", ["-x", "-f", "-", "-C", tmpDir], { input: archive });

    // node_modules is NOT git-tracked — copy it from the LIVE source. Its integrity is bound to
    // the lockfile by assertShippedClosureMatchesLockfile (and the lockfile itself now comes from
    // the snapshot), so a live node_modules cannot smuggle in bytes the lockfile does not pin.
    // cpSync's `dereference` follows ONLY the top-level path — a NESTED symlink (an npm-linked
    // dependency, a .bin entry) survives the recursive copy as a link pointing OUT of the
    // release. Shipped, it would silently load mutable host code once the source tree moved or
    // changed. Dereference every nested link into real bytes; the archived git-tracked dirs get
    // the same treatment for any tracked symlink so the whole closure stays link-free.
    cpSync(join(sourceRoot, "node_modules"), join(tmpDir, "node_modules"), { recursive: true, dereference: true });
    for (const rel of ["node_modules", "src", ...REQUIRED_ASSET_DIRS, "dashboard"]) {
      dereferenceSymlinks(join(tmpDir, rel));
    }

    writeFileSync(join(tmpDir, RELEASE_LOADER_NAME), LOADER_SHIM);
    const entryPath = join(tmpDir, RELEASE_ENTRY_NAME);
    writeFileSync(entryPath, renderEntry(interpreter));
    chmodSync(entryPath, 0o755);

    // MUST-FIX 3: the manifest's lockfile SHA must describe the SHIPPED closure, so
    // hash the release's OWN copied lockfile (the selected one) — not the source at
    // build time.
    const manifest: ReleaseManifest = {
      schema: 1,
      id,
      commit,
      builderCommit,
      interpreter,
      abi: process.versions.modules,
      nodeVersion: process.version,
      lockfile: lockfileIdentity(tmpDir, lockfileName),
      builtAt: now.toISOString(),
      entry: RELEASE_ENTRY_SOURCE,
      binding: RELEASE_BINDING_REL,
      selfContainedFor: "control-plane+dashboard",
    };
    writeFileSync(join(tmpDir, RELEASE_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n");

    // FG-569 (Finding 3): FREEZE the staging tree BEFORE the atomic rename — clear the
    // write bits on every file so the closure is immutable at rest — then VERIFY the
    // now-frozen tree, THEN rename the already-frozen tree into place. The final
    // release path is never observed with a writable file, so there is no post-rename
    // mutation window.
    freezeReleaseFiles(tmpDir);

    // Verify the FROZEN closure — both gates only READ the tree:
    //  - FIX 4 + FIX 5: it RUNS under the pinned interpreter (the tsx loader loads and
    //    better-sqlite3 loads from the release's OWN node_modules), and
    //  - FG-569: its shipped bytes MATCH the selected lockfile — a content-mutated dep
    //    with an untouched lockfile is refused rather than shipped.
    // Proven AFTER the freeze, so the thing that ships is exactly what was verified.
    assertReleaseCloses(tmpDir, interpreter);
    assertShippedClosureMatchesLockfile(tmpDir, lockfileName);
    // FG-580: the SHIPPED closure carries a complete dashboard runtime — entry, tsconfig,
    // representative static asset, vendored client libs, and dashboard-relevant deps. A
    // copy that dropped any of them is refused here, before publish, so a promoted release
    // never ships a dashboard that cannot boot offline. Unconditional: the mandatory gate
    // above guarantees every release bundles the dashboard.
    assertDashboardClosure(tmpDir);

    mkdirSync(dirname(outDir), { recursive: true });
    // Atomic publish of the already-frozen closure into its final, immutable path.
    renameSync(tmpDir, outDir);

    return { manifest, releaseDir: outDir, entryPath: join(outDir, RELEASE_ENTRY_NAME) };
  } catch (e) {
    // The freeze may already have run (a post-freeze gate can throw — e.g. the
    // lockfile byte-binding), leaving read-only directories a recursive unlink
    // can't traverse. Restore write bits before removing, so a refused build
    // still leaves no release behind.
    if (existsSync(tmpDir)) thawReleaseTree(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
    throw e;
  }
}

export type ReleaseManifestLocation =
  | { kind: "none" }
  | { kind: "release"; manifest: ReleaseManifest; releaseDir: string }
  | { kind: "malformed"; releaseDir: string; error: string };

/** Walk up from `startDir` to the nearest release root (a dir holding
 *  forge-release.json) and report what is there. A manifest that is PRESENT but
 *  unreadable is `malformed`, NOT `none`: the caller is demonstrably inside a
 *  release, and collapsing that into "no release" lets a gate fall back to dev
 *  defaults for a release it could not verify. */
export function locateReleaseManifest(startDir: string): ReleaseManifestLocation {
  let dir = isAbsolute(startDir) ? startDir : resolve(startDir);
  for (;;) {
    const p = join(dir, RELEASE_MANIFEST_NAME);
    if (existsSync(p)) {
      try {
        return { kind: "release", manifest: JSON.parse(readFileSync(p, "utf8")) as ReleaseManifest, releaseDir: dir };
      } catch (e) {
        return { kind: "malformed", releaseDir: dir, error: (e as Error).message };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return { kind: "none" };
    dir = parent;
  }
}

/** Walk up from `startDir` to the nearest release root and return the parsed
 *  manifest, or null if the caller is not running inside a usable release (e.g.
 *  the dev bin/forge). Callers that must distinguish a malformed manifest from
 *  the absence of one — the ABI preflight — use locateReleaseManifest instead. */
export function readReleaseManifest(startDir: string): { manifest: ReleaseManifest; releaseDir: string } | null {
  const found = locateReleaseManifest(startDir);
  return found.kind === "release" ? { manifest: found.manifest, releaseDir: found.releaseDir } : null;
}

export type RuntimeProvenance = {
  pid: number;
  execPath: string;
  abi: string;
  nodeVersion: string;
  bindingLoads: boolean;
  release: ReleaseManifest | null;
  match: { interpreter: boolean; abi: boolean } | null;
  // FG-571 (FG571-RI): the release identity AS CARRIED IN THIS PROCESS'S ENVIRONMENT — what
  // every process forge starts (notably the `forge launch` exit-recorder) records as
  // provenance. Distinct from `release` above, which is read from the manifest on disk:
  // this is the value the launcher actually put here, so it is the thing that must be
  // asserted from a RUNNING process to prove a caller's forged FORGE_RELEASE_ID did not
  // survive. null on the dev entry (bin/forge-dev unsets it and has no manifest — "not
  // recorded, never manufactured"); on a stable release it is the selected release's
  // manifest id, or the launcher refused to start at all.
  releaseId: string | null;
};

/** R1: report the RUNNING process's own runtime — process.execPath IS the
 *  control runtime. When run inside a release, compare it against the manifest.
 *  `requireFrom` resolves better-sqlite3 from the running module's location so
 *  bindingLoads reflects THIS closure's binding. */
export function collectProvenance(fromModuleDir: string, requireFrom: NodeRequire): RuntimeProvenance {
  const found = readReleaseManifest(fromModuleDir);
  let bindingLoads = false;
  try {
    const Database = requireFrom("better-sqlite3") as new (p: string) => { close(): void };
    const db = new Database(":memory:");
    db.close();
    bindingLoads = true;
  } catch {
    bindingLoads = false;
  }
  const execPath = process.execPath;
  const abi = process.versions.modules;
  return {
    pid: process.pid,
    execPath,
    abi,
    nodeVersion: process.version,
    bindingLoads,
    release: found?.manifest ?? null,
    match: found ? { interpreter: execPath === found.manifest.interpreter, abi: abi === found.manifest.abi } : null,
    // Reported verbatim, never manufactured: an absent carrier reads as "not recorded"
    // (null), never as a guessed or manifest-substituted value.
    releaseId: process.env.FORGE_RELEASE_ID ?? null,
  };
}

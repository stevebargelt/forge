// FG-728: the integration-tier build preload. Wired via `--import` in
// scripts/run-integration-tests.sh (alongside `--import tsx` and
// `--import ./src/test-setup.ts`) so it runs ONCE per `node --test` process,
// BEFORE any test file loads. It esbuild-transpiles the whole src/ graph — per
// file, structure-preserving — into INTEGRATION_BUILD_DIR, so integration suites
// can spawn `node <builtEntry>` instead of paying the tsx cold-transpile tax on
// every CLI spawn (the ticket's entire objective).
//
// Design invariants (do not "optimize" these away):
//   - PER-FILE MIRROR, never a single-file --bundle. Only relative/bare imports
//     are marked external; every source file maps 1:1 to an output file at the
//     mirrored path, so `import.meta.url` in the built tree points at the same
//     relative offset from the repo root as the src file did under tsx. A bundle
//     collapses that and mis-resolves seeds/templates/docker/git-root.
//   - MANIFEST-LESS. The build emits no `forge release` manifest, so
//     asset-root.ts's executionMode resolves to `dev` exactly as tsx does. Never
//     reuse a real release artifact for this.
//   - ALWAYS REBUILD. The build and the run share one ephemeral process, so a
//     staleness check would be pure risk for no gain — wipe and rebuild.
//   - FAIL CLOSED. If esbuild throws, THROW so the whole job fails loudly with the
//     build output; never let a suite run against a stale/absent tree.
//   - INTEGRATION TIER ONLY. This must NEVER move into src/test-setup.ts, which
//     the unit + worktree tiers share — build cost there would regress exactly the
//     runner-minutes this ticket removes.
//
// esbuild is currently only a TRANSITIVE dependency (a direct dep of tsx). It is
// imported by bare specifier here and resolves today; the host should promote it
// to a direct devDependency + regenerate the lockfile (the container mount is
// read-only, so that could not be finalized here).

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import esbuild from "esbuild";
import { INTEGRATION_BUILD_DIR, SRC_DIR } from "./integration-cli-spawn.js";

// JS reserved words cannot be re-emitted as `export const <word>` (a JSON file
// like package.json has a top-level `private` key). They are still reachable via
// the default export; only the named re-export is skipped.
const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for",
  "function", "if", "import", "in", "instanceof", "new", "null", "return", "super",
  "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while",
  "with", "yield", "let", "static", "await", "implements", "interface", "package",
  "private", "protected", "public",
]);

// Native ESM JSON modules expose ONLY a default export, so `import { version }
// from "../../package.json" with { type: "json" }` — valid under tsx's loader —
// throws under plain `node`. This plugin resolves .json imports to a synthetic JS
// module that re-exports each top-level key by name (plus a default), so the built
// CLI runs the named-import form unchanged. Everything else (relative + bare
// specifiers) is externalized, which is what keeps the build a per-file mirror
// rather than a bundle.
const mirrorPlugin: esbuild.Plugin = {
  name: "forge-integration-mirror",
  setup(build) {
    build.onResolve({ filter: /\.json$/ }, (args) => {
      if (args.kind === "entry-point") return undefined;
      return { path: resolve(args.resolveDir, args.path), namespace: "forge-json" };
    });
    build.onLoad({ filter: /.*/, namespace: "forge-json" }, (args) => {
      const data = JSON.parse(readFileSync(args.path, "utf8")) as Record<string, unknown>;
      const named = Object.keys(data)
        .filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) && !RESERVED.has(k))
        .map((k) => `export const ${k} = ${JSON.stringify(data[k])};`);
      return { contents: `${named.join("\n")}\nexport default ${JSON.stringify(data)};`, loader: "js" };
    });
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return undefined;
      return { path: args.path, external: true };
    });
  },
};

const entryPoints = readdirSync(SRC_DIR, { recursive: true })
  .filter((f): f is string => typeof f === "string" && f.endsWith(".ts"))
  .map((f) => resolve(SRC_DIR, f));

rmSync(INTEGRATION_BUILD_DIR, { recursive: true, force: true });

await esbuild.build({
  entryPoints,
  outdir: INTEGRATION_BUILD_DIR,
  outbase: SRC_DIR,
  bundle: true, // required for the plugin's onResolve/onLoad; nothing is actually bundled (all imports external)
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: false,
  logLevel: "warning",
  plugins: [mirrorPlugin],
});

// FG-253 — the ONE resolver for "which forge rendered these adapter bytes?".
//
// It used to live twice. The installer (src/cli/commands/init.ts) derived a dev
// stamp from the checkout's realpath; the drift detector (src/v2/seed-drift.ts)
// derived one from the rendered bytes. Under a release both read the manifest id
// and agreed, which is why no test caught that on a DEV CHECKOUT — forge's own
// npm-linked loop, the way CLAUDE.md documents this repo running — `forge init`
// wrote a path identity, `forge doctor` compared it against a content identity,
// disagreed, and reported every adapter drifted forever: the remedy it named
// rewrote the same bytes with the same disagreeing stamp, so it converged nothing.
//
// WHY IT IS NOT IN operator-workflows.ts, the provider-neutral home for the
// adapter vocabulary: resolving a stamp READS THE FILESYSTEM (the release
// manifest), and that module is deliberately pure. WHY IT IS NOT IN either of its
// two former homes: the installer must not have to depend on the drift detector to
// learn its own identity, nor the reverse. So it is its own module, and both
// import it.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { assetRoot } from "./asset-root.js";
import { sha256OfString } from "../util/content-digest.js";
import { isValidAdapterStamp, type AdapterStamp } from "./operator-workflows.js";
import { renderClaudeCommands } from "./render-claude-commands.js";
import { renderCodexSkills } from "./render-codex-skills.js";
import { readReleaseManifest } from "./release.js";

/** A stamp for a tree that carries no release manifest (a dev checkout / npm-link).
 *
 *  CONTENT identity, and deliberately not the two alternatives. Not a bare "dev":
 *  that would make two unrelated trees compare EQUAL, the single comparison the
 *  stamp exists to get right. Not the checkout's path: a stamp names what the bytes
 *  ARE, and a path identity makes two checkouts of the same commit compare unequal
 *  for no reason while staying identical after the definition under it changes.
 *  Rendered against a fixed probe stamp so the value is the identity of the
 *  DEFINITION, not of whatever stamp the last render happened to embed. */
function devAdapterStamp(): AdapterStamp {
  const probe = "stamp-probe";
  const rendered = [
    ...renderClaudeCommands(probe).map((c) => `${c.path}\n${c.bytes}`),
    ...renderCodexSkills(probe).map((s) => `${s.path}\n${s.contents}`),
  ].join("\n");
  return `dev.${sha256OfString(rendered).slice(0, 12)}`;
}

/** A release tree's own name for itself, or null when the tree carries no manifest. */
function releaseAdapterStamp(root: string): AdapterStamp | null {
  const id = readReleaseManifest(root)?.manifest.id;
  if (id === undefined) return null;
  // A manifest id is a plain token by construction. One that could not survive the
  // marker's HTML comment is hashed rather than sanitized or thrown on: an odd
  // release still gets an opaque-but-distinct identity that still says `release`,
  // instead of making `forge init` unusable, claiming a name the bytes did not come
  // from, or reporting a release build as a dev tree.
  return isValidAdapterStamp(id) ? id : `release.${sha256OfString(id).slice(0, 12)}`;
}

/** The stamp the RUNNING forge renders adapters with, for every caller: the
 *  installer, the drift detector, and the launch-boundary generation check. A
 *  release names itself by its manifest id; a dev checkout has no such name and
 *  falls back to the content identity above. */
export function currentAdapterStamp(): AdapterStamp {
  return releaseAdapterStamp(assetRoot()) ?? devAdapterStamp();
}

/** The stamp the forge at `root` renders adapters with — for a caller comparing a
 *  project against a release that is NOT the one executing. FG-253 step 8's launch
 *  check needs this: an adapter can bind its instruction surface out of a PUBLISHED
 *  seed generation, and a failed or deferred publication leaves that generation
 *  behind the running assets.
 *
 *  Null is a real answer and must not be papered over. A tree with no release
 *  manifest has only a CONTENT identity, and the only content this process can render
 *  is its own — so for somebody else's dev checkout there is nothing here to compute.
 *  Returning the running stamp instead would make a drift detector report agreement
 *  with a generation it never looked at, which is the failure this function exists to
 *  stop. */
export function adapterStampForAssetRoot(root: string): AdapterStamp | null {
  const release = releaseAdapterStamp(root);
  if (release !== null) return release;
  return isSameTree(root, assetRoot()) ? devAdapterStamp() : null;
}

function isSameTree(a: string, b: string): boolean {
  const real = (p: string): string => {
    try { return realpathSync(p); } catch { return resolve(p); }
  };
  return real(a) === real(b);
}

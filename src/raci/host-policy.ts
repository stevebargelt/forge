// forge RACI — keep the DERIVED host routing policy in lockstep with the RACI
// seed during install/upgrade (#286).
//
// routing-policy.yml is generated from forge-raci.md; humans must never
// hand-maintain it. So `forge init` and `forge upgrade` recompile it whenever the
// RACI seed is installed/refreshed, rather than leaving the operator to remember
// `forge route compile` (which the drift detector would otherwise nag about right
// after a successful upgrade — using the safety net as the routine reminder is
// backwards). A compile failure is returned, never thrown, so the caller can warn
// loudly with the exact reason without aborting the rest of init/upgrade.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { compileRaciDocument } from "./compile.js";

export type CompilePolicyResult =
  | { ok: true; routes: number; wrote: boolean }
  | { ok: false; error: string };

/** Compile a RACI source file into a routing-policy.yml. With write:false it
 *  validates by compiling in memory (dry-run) without touching disk. A missing
 *  source or compile error is returned, not thrown. */
export function compilePolicyFile(
  raciPath: string,
  outPath: string,
  opts: { write?: boolean } = {},
): CompilePolicyResult {
  const write = opts.write ?? true;
  if (!existsSync(raciPath)) return { ok: false, error: `RACI source not found: ${raciPath}` };
  let policy;
  try {
    policy = compileRaciDocument(readFileSync(raciPath, "utf8"));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (write) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, yamlStringify(policy));
  }
  return { ok: true, routes: Object.keys(policy.routes).length, wrote: write };
}

export type EnsureHostPolicyResult = { ok: boolean; status: string; routes?: number };

/** Ensure the host routing policy is compiled from the effective host RACI, used
 *  by init/upgrade. Decision table:
 *   - RACI present                  -> recompile the policy (it's derived).
 *   - no RACI but policy present     -> standalone escape hatch; leave it ALONE.
 *   - neither, but a seed exists     -> install the seed RACI (create-only), compile.
 *   - neither, and no seed           -> nothing to do; report.
 *  Never overwrites an existing host RACI and never clobbers a hand-authored
 *  standalone policy.
 *
 *  FG-578: create-only is no longer deference to a caller who would overwrite it
 *  anyway — install-seeds.sh does NOT hold that authority now, and NOTHING does.
 *  ~/.forge/forge-raci.md is the operator's authored source (the `forge raci
 *  apply` channel audits every change to it), so forge seeds it and then only
 *  ever READS it. The derived routing-policy.yml is the opposite and is
 *  recompiled here on every pass: ownership follows the artifact, not the
 *  directory the two happen to share. */
export function ensureHostRoutingPolicy(opts: {
  raciPath: string;
  policyPath: string;
  seedRaciPath?: string;
  dryRun?: boolean;
}): EnsureHostPolicyResult {
  const dryRun = opts.dryRun ?? false;
  const raciExists = existsSync(opts.raciPath);

  if (!raciExists && existsSync(opts.policyPath)) {
    return { ok: true, status: "standalone policy left as-is (no host RACI to derive from)" };
  }

  let sourceRaci = opts.raciPath;
  let installing = false;
  if (!raciExists) {
    if (!opts.seedRaciPath || !existsSync(opts.seedRaciPath)) {
      return { ok: false, status: "no host RACI/policy and no RACI seed to install" };
    }
    installing = true;
    if (dryRun) {
      sourceRaci = opts.seedRaciPath; // compile-in-memory from the seed to validate
    } else {
      mkdirSync(dirname(opts.raciPath), { recursive: true });
      copyFileSync(opts.seedRaciPath, opts.raciPath);
      sourceRaci = opts.raciPath;
    }
  }

  const res = compilePolicyFile(sourceRaci, opts.policyPath, { write: !dryRun });
  if (!res.ok) return { ok: false, status: `RACI compile FAILED — ${res.error}` };

  const verb = dryRun ? "would compile" : "compiled";
  const prefix = installing ? (dryRun ? "would install RACI seed + " : "installed RACI seed + ") : "";
  return { ok: true, status: `${prefix}${verb} routing policy (${res.routes} routes)`, routes: res.routes };
}

// FG-346: the model-policy CATALOG — the single, deliberately-owned drift surface
// for the two things the model-policy parser does NOT validate:
//
//   1. family -> concrete model id.  The parser accepts any `model:` string. When
//      `forge setup` GENERATES a policy it must emit real, current model ids, not
//      free text. Rather than hardcode ids here (which would silently drift from
//      the shipped seed), we PARSE the installed seed (seeds/model-policy.example.yml)
//      and read the concrete id out of it per (provider, auth, family). The FAMILY
//      STRUCTURE (which families each provider/auth offers, and which seed profile +
//      capability names the family) is the owned knowledge; the concrete ids are
//      derived so a seed model-id bump is picked up automatically and a seed
//      rename fails the catalog test loudly.
//
//   2. valid overrides.agents role keys.  The parser accepts any role string, so a
//      typo'd/invented role (`reserch-skpetic`) parses clean and simply never fires.
//      There is no TypeScript role registry — roles are declared as directories
//      under seeds/agents/. knownAgentRoles() reads that directory listing so the
//      generator can REJECT any override key that is not a real agent role.
//
// Pure over the on-disk seed; every id and role in a generated policy comes from
// here, nothing free-text. See model-policy-generator.ts / model-policy-choices.ts.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assetRoot } from "./asset-root.js";
import type { EffectiveAuth } from "./model-resolution.js";
import type { CostTier } from "./schema.js";

// ── The owned family structure ──────────────────────────────────────────────
//
// Keyed by `${provider}/${auth}`. Each entry names, for one model family, the seed
// profile + capability whose `model:` is that family's concrete id. This is the
// ONLY place the family->seed mapping lives.

type FamilySource = {
  family: string;
  /** Seed profile (in seeds/model-policy.example.yml) that carries this family's id. */
  seedProfile: string;
  /** Capability within that seed profile's `map:` whose `model:` is the family id. */
  seedCapability: string;
};

const FAMILY_SOURCES: Record<string, FamilySource[]> = {
  "anthropic/subscription": [
    { family: "opus", seedProfile: "claude-subscription", seedCapability: "reasoning" },
    { family: "sonnet", seedProfile: "claude-subscription", seedCapability: "review" },
    { family: "haiku", seedProfile: "claude-subscription", seedCapability: "fast" },
  ],
  "anthropic/bedrock": [
    // Work-account Bedrock does NOT expose Opus — sonnet is the strongest there.
    { family: "sonnet", seedProfile: "claude-bedrock", seedCapability: "reasoning" },
    { family: "haiku", seedProfile: "claude-bedrock", seedCapability: "fast" },
  ],
  "anthropic/api": [
    { family: "opus", seedProfile: "claude-api", seedCapability: "reasoning" },
    { family: "sonnet", seedProfile: "claude-api", seedCapability: "review" },
    { family: "haiku", seedProfile: "claude-api", seedCapability: "fast" },
  ],
  "openai/subscription": [
    // Codex is a single family; take its id from the profile default.
    { family: "codex", seedProfile: "codex-subscription", seedCapability: "default" },
  ],
  "groq/api": [
    { family: "kimi", seedProfile: "pi-groq", seedCapability: "default" },
  ],
};

// Coarse cost tier per family — mirrors the seed's own labels (opus premium,
// sonnet standard, haiku cheap). Used when the generator emits capability entries.
const COST_TIER_BY_FAMILY: Record<string, CostTier> = {
  opus: "premium",
  sonnet: "standard",
  haiku: "cheap",
  codex: "standard",
  kimi: "standard",
};

// Providers whose model runs THROUGH an explicit forge runtime rather than the
// (provider, auth) binding table. For these, a generated profile must carry the
// `runtime:` field, and structured capabilities must set tool_capable: true
// (dispatch's checkToolCapability refuses a runtime-fronted profile otherwise).
// The runtime name is read from the seed profile so it can't drift.
const RUNTIME_FRONTED_PROVIDERS: Record<string, { seedProfile: string }> = {
  groq: { seedProfile: "pi-groq" },
};

// ── Seed parsing (cached) ────────────────────────────────────────────────────

type SeedProfile = {
  provider?: string;
  auth?: string;
  runtime?: string;
  map?: Record<string, { model?: string; cost_tier?: string }>;
};
type SeedPolicy = { model_profiles?: Record<string, SeedProfile> };

let seedCache: SeedPolicy | undefined;

function seedPolicyPath(): string {
  return join(assetRoot(), "seeds", "model-policy.example.yml");
}

function loadSeed(): SeedPolicy {
  if (seedCache) return seedCache;
  const raw = readFileSync(seedPolicyPath(), "utf8");
  seedCache = (parseYaml(raw) as SeedPolicy) ?? {};
  return seedCache;
}

function providerAuthKey(provider: string, auth: EffectiveAuth): string {
  return `${provider}/${auth}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** The families offerable for a (provider, auth), in display order. Empty for an
 *  unknown pair. Purely the owned family structure — availability gating lives in
 *  model-policy-choices.ts, not here. */
export function familiesFor(provider: string, auth: EffectiveAuth): string[] {
  return (FAMILY_SOURCES[providerAuthKey(provider, auth)] ?? []).map((f) => f.family);
}

/** The concrete model id for a (provider, auth, family), read out of the installed
 *  seed. undefined when the pair/family is unknown OR the seed no longer carries
 *  the named profile/capability (a drift the catalog test surfaces loudly). */
export function modelIdForFamily(
  provider: string,
  auth: EffectiveAuth,
  family: string,
): string | undefined {
  const source = (FAMILY_SOURCES[providerAuthKey(provider, auth)] ?? []).find(
    (f) => f.family === family,
  );
  if (!source) return undefined;
  const seedProfile = loadSeed().model_profiles?.[source.seedProfile];
  const model = seedProfile?.map?.[source.seedCapability]?.model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

/** Coarse cost tier for a family (defaults to "standard"). */
export function costTierForFamily(family: string): CostTier {
  return COST_TIER_BY_FAMILY[family] ?? "standard";
}

/** True when a provider runs through an explicit forge runtime (pi/groq etc.),
 *  so generated profiles must carry `runtime:` and mark structured capabilities
 *  tool_capable. */
export function isRuntimeFronted(provider: string): boolean {
  return provider in RUNTIME_FRONTED_PROVIDERS;
}

/** The explicit runtime name a runtime-fronted provider's generated profile must
 *  carry, read from the seed so it can't drift. undefined for direct providers. */
export function runtimeForProvider(provider: string): string | undefined {
  const meta = RUNTIME_FRONTED_PROVIDERS[provider];
  if (!meta) return undefined;
  const runtime = loadSeed().model_profiles?.[meta.seedProfile]?.runtime;
  return typeof runtime === "string" && runtime.length > 0 ? runtime : undefined;
}

let rolesCache: string[] | undefined;

/** Valid overrides.agents role keys — the seeds/agents/ directory listing. This is
 *  the ONLY source of truth for real agent roles (no TS registry exists). */
export function knownAgentRoles(): string[] {
  if (rolesCache) return rolesCache;
  const dir = join(assetRoot(), "seeds", "agents");
  rolesCache = readdirSync(dir)
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  return rolesCache;
}

/** True when `role` is a real agent role (a seeds/agents/<role> directory). */
export function isKnownRole(role: string): boolean {
  return knownAgentRoles().includes(role);
}

/** Test seam: drop the cached seed/roles so a test that swaps FORGE assets or the
 *  asset root re-reads from disk. */
export function __resetCatalogCacheForTest(): void {
  seedCache = undefined;
  rolesCache = undefined;
}

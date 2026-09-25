// FG-804: the ONE declared place forge records which Claude Code CLI version a
// model needs. The API refuses a model the CLI is too old for ("Claude Code 2.1.224
// does not support this model; version 2.1.280 or newer is required"), so doctor
// compares the in-image `claude --version` against this table for every model the
// host policy / runtime aliases can resolve to. The Dockerfile's
// CLAUDE_CODE_VERSION ARG must satisfy every floor here (guarded by a test).

export type ClaudeCliFloor = {
  /** A model id or family stem. Matches a model id that CONTAINS it as a whole
   *  token, so Bedrock (`us.anthropic.claude-opus-5-5-v1:0`) and suffixed
   *  (`claude-opus-5-5[1m]`) spellings are covered by the one entry. */
  model: string;
  minVersion: string;
};

export const CLAUDE_CLI_FLOORS: readonly ClaudeCliFloor[] = [
  { model: "claude-opus-5-5", minVersion: "2.1.280" },
];

function containsToken(modelId: string, stem: string): boolean {
  let from = 0;
  for (;;) {
    const i = modelId.indexOf(stem, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : modelId[i - 1]!;
    const after = modelId[i + stem.length] ?? "";
    // `claude-opus-5-5` must not match `claude-opus-5-50`, nor `xclaude-opus-5-5`.
    if (!/[a-z0-9]/i.test(before) && !/[0-9]/.test(after)) return true;
    from = i + 1;
  }
}

/** The minimum Claude Code CLI version a model id needs, or undefined when no
 *  floor is declared. When several entries match, the highest floor wins. */
export function requiredClaudeCliVersion(modelId: string): string | undefined {
  const id = modelId.toLowerCase();
  let best: string | undefined;
  for (const f of CLAUDE_CLI_FLOORS) {
    if (!containsToken(id, f.model.toLowerCase())) continue;
    if (best === undefined || compareVersions(f.minVersion, best) > 0) best = f.minVersion;
  }
  return best;
}

/** Pull the semver out of `claude --version` output (`2.1.281 (Claude Code)`),
 *  keeping any prerelease tag (`2.1.280-beta.1`) so it compares BELOW its final
 *  release. undefined when the output carries no recognizable version. */
export function parseClaudeCliVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/.exec(output)?.[0];
}

/** Semver precedence: numeric core first, then a prerelease sorts below the
 *  same core without one (`2.1.280-beta.1` < `2.1.280`). */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitPrerelease(a);
  const [coreB, preB] = splitPrerelease(b);
  const pa = coreA.split(".").map(Number);
  const pb = coreB.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  if (preA === undefined || preB === undefined) {
    return preA === preB ? 0 : preA === undefined ? 1 : -1;
  }
  const ia = preA.split(".");
  const ib = preB.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function splitPrerelease(v: string): [string, string | undefined] {
  const i = v.indexOf("-");
  return i < 0 ? [v, undefined] : [v.slice(0, i), v.slice(i + 1)];
}

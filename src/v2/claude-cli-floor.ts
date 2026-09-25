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

/** Pull the semver out of `claude --version` output (`2.1.281 (Claude Code)`).
 *  undefined when the output carries no recognizable version. */
export function parseClaudeCliVersion(output: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

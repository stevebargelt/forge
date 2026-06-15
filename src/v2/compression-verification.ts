import { writeFileSync } from "node:fs";
import { compressPrompt, COMPRESSION_THRESHOLD } from "./compression.js";

export const RESULT_COMPRESSION_THRESHOLD = 20 * 1024; // 20KB

export type CompressionVerification = {
  agent_compressed: boolean;
  orchestrator_compressed: boolean;
  fields_compressed: string[];
};

/** True if the result carries any agent-written *_compressed metadata field. */
export function hasAgentCompressionMetadata(result: Record<string, unknown>): boolean {
  return Object.keys(result).some(
    (k) =>
      k.endsWith("_compressed") &&
      result[k] !== null &&
      typeof result[k] === "object" &&
      !Array.isArray(result[k]),
  );
}

/** String fields whose UTF-8 byte size exceeds the per-field compression threshold. */
export function findLargeStringFields(result: Record<string, unknown>): string[] {
  return Object.entries(result)
    .filter(([, v]) => typeof v === "string" && Buffer.byteLength(v, "utf8") > COMPRESSION_THRESHOLD)
    .map(([k]) => k);
}

/** Orchestrator safety net: if the result exceeds 20KB and has no agent compression
 *  metadata, compress large string fields and rewrite result.json. Returns the
 *  (possibly modified) result and the verification metadata; returns null verification
 *  when the result is below threshold (nothing to act on). */
export async function maybeOrchestratorCompress(args: {
  result: unknown;
  resultRawSize: number;
  resultPath: string;
  taskId: string;
  _compress?: Parameters<typeof compressPrompt>[1];
}): Promise<{ result: unknown; verification: CompressionVerification | null }> {
  if (
    !args.result ||
    typeof args.result !== "object" ||
    Array.isArray(args.result) ||
    args.resultRawSize <= RESULT_COMPRESSION_THRESHOLD
  ) {
    return { result: args.result, verification: null };
  }

  const r = args.result as Record<string, unknown>;
  const agentCompressed = hasAgentCompressionMetadata(r);

  if (agentCompressed) {
    return {
      result: r,
      verification: { agent_compressed: true, orchestrator_compressed: false, fields_compressed: [] },
    };
  }

  const largeFields = findLargeStringFields(r);
  if (largeFields.length === 0) {
    return {
      result: r,
      verification: { agent_compressed: false, orchestrator_compressed: false, fields_compressed: [] },
    };
  }

  const sizeKb = Math.round(args.resultRawSize / 1024);
  console.error(
    `forge: agent ${args.taskId} did not compress ${sizeKb}KB output, orchestrator compressed post-hoc`,
  );

  const fieldsCompressed: string[] = [];
  const out: Record<string, unknown> = { ...r };
  for (const field of largeFields) {
    const value = out[field];
    if (typeof value !== "string") continue;
    const { content, meta } = await compressPrompt(value, args._compress);
    if (meta.method !== "none") {
      out[field] = content;
      fieldsCompressed.push(field);
    }
  }

  const verification: CompressionVerification = {
    agent_compressed: false,
    orchestrator_compressed: fieldsCompressed.length > 0,
    fields_compressed: fieldsCompressed,
  };

  const withVerification: Record<string, unknown> = { ...out, compressionVerification: verification };
  writeFileSync(args.resultPath, JSON.stringify(withVerification));

  return { result: withVerification, verification };
}

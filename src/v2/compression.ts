import { compress as headroomCompress, type CompressResult as HeadroomResult } from "headroom-ai";

export type CompressionMeta = {
  original_size: number;
  compressed_size: number;
  compression_ratio: number;
  method: "headroom" | "none";
};

export type CompressResult = {
  content: string;
  meta: CompressionMeta;
};

export const COMPRESSION_THRESHOLD = 10 * 1024; // 10KB

type CompressFn = (messages: { role: string; content: string }[]) => Promise<HeadroomResult>;

export async function compressPrompt(
  text: string,
  _compress: CompressFn = headroomCompress,
): Promise<CompressResult> {
  const original_size = Buffer.byteLength(text, "utf8");

  if (original_size <= COMPRESSION_THRESHOLD) {
    return {
      content: text,
      meta: { original_size, compressed_size: original_size, compression_ratio: 1.0, method: "none" },
    };
  }

  try {
    const result = await _compress([{ role: "system", content: text }]);
    const compressed = result.messages[0];
    const compressedText =
      compressed && typeof compressed === "object" && "content" in compressed
        ? String(compressed.content)
        : text;
    const compressed_size = Buffer.byteLength(compressedText, "utf8");
    return {
      content: compressedText,
      meta: {
        original_size,
        compressed_size,
        compression_ratio: result.compressionRatio,
        method: "headroom",
      },
    };
  } catch (e) {
    console.warn(`forge: compression failed, using uncompressed content: ${(e as Error).message}`);
    return {
      content: text,
      meta: { original_size, compressed_size: original_size, compression_ratio: 1.0, method: "none" },
    };
  }
}

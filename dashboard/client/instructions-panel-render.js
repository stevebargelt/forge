// FG-827: the role page's Instructions panel, as data — the Files list (every source that
// composes the role's instructions, in composition order, the seed CLAUDE.md marked
// ENTRY), the viewer's Read / Raw / Composed modes, and what the copy button copies.
// Pure; instructions-panel-view.js renders it. Read mode renders through markdown.js's
// md() — the dashboard's one sanitizing Markdown boundary (FG-643).

import { instructionSections } from "./role-page-render.js";

export const INSTRUCTION_MODES = Object.freeze([
  { id: "read", label: "Read" },
  { id: "raw", label: "Raw" },
  { id: "composed", label: "Composed" },
]);

const KIND_LABELS = {
  entry: "ENTRY",
  protocol: "PROTOCOL",
  addendum: "ADDENDUM",
  workflow: "WORKFLOW",
  constraint: "CONSTRAINT",
};

export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? String(kind ?? "").toUpperCase();
}

function formatBytes(n) {
  if (typeof n !== "number") return "";
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** The Files list, in the server's composition order, the selected one flagged. */
export function instructionFileRows(instructions, selectedId) {
  const files = Array.isArray(instructions?.files) ? instructions.files : [];
  return files.map((f) => ({
    id: f.id,
    label: f.label,
    kind: f.kind,
    badge: kindLabel(f.kind),
    entry: f.kind === "entry",
    bytes: formatBytes(f.bytes),
    selected: f.id === selectedId,
  }));
}

/** The file a fresh panel opens on: the entry (the seed CLAUDE.md), else the first. */
export function defaultFileId(instructions) {
  const files = Array.isArray(instructions?.files) ? instructions.files : [];
  return (files.find((f) => f.kind === "entry") ?? files[0])?.id ?? null;
}

export function selectedFile(instructions, selectedId) {
  const files = Array.isArray(instructions?.files) ? instructions.files : [];
  return files.find((f) => f.id === selectedId) ?? files.find((f) => f.id === defaultFileId(instructions)) ?? null;
}

/** A file's YAML frontmatter split from its Markdown body, so Read mode renders the body
 *  and shows the frontmatter as the literal text it is. */
export function splitFrontmatter(markdown) {
  const text = String(markdown ?? "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1], body: text.slice(m[0].length) };
}

/** The composed prompt section a file became: its kind in the segmenter's vocabulary. */
export function sectionMatchesFile(section, fileId) {
  if (!fileId) return false;
  if (fileId === "entry") return section.kind === "base";
  if (fileId.startsWith("constraint:")) return section.kind === "constraint" && section.id === fileId.slice("constraint:".length);
  return section.kind === fileId;
}

/** Composed mode: the exact bytes, cut at the server's section bounds, the selected
 *  file's section flagged. */
export function composedSections(instructions, selectedId) {
  return instructionSections(instructions).map((s) => ({ ...s, selected: sectionMatchesFile(s, selectedId) }));
}

/** What the copy button copies: the whole composed prompt in Composed mode, else the
 *  selected file's bytes. */
export function copyPayload(instructions, selectedId, mode) {
  if (mode === "composed") return instructions?.ok ? instructions.prompt : "";
  return selectedFile(instructions, selectedId)?.markdown ?? "";
}

/** The caption over a source's declared bytes when its composed section differs. */
export function rawCaption(file) {
  return `${file?.path ? "as on disk" : "as declared"}; the composed section differs (${file?.rawDiff || "differs"})`;
}

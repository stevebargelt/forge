export interface InstructionFile {
  id: string;
  label: string;
  kind: string;
  path: string | null;
  markdown: string;
  start?: number;
  end?: number;
  bytes: number;
  raw?: string;
  rawDiff?: string;
  edit: string;
}
export interface PanelInstructions {
  ok: boolean;
  prompt?: string;
  sha256?: string;
  sections?: Array<{ kind: string; id?: string; title: string; start: number; end: number }>;
  files?: InstructionFile[];
}
export const INSTRUCTION_MODES: ReadonlyArray<{ id: string; label: string }>;
export function kindLabel(kind: string | null | undefined): string;
export function instructionFileRows(instructions: PanelInstructions | null | undefined, selectedId: string | null): Array<{ id: string; label: string; kind: string; badge: string; entry: boolean; bytes: string; selected: boolean }>;
export function defaultFileId(instructions: PanelInstructions | null | undefined): string | null;
export function selectedFile(instructions: PanelInstructions | null | undefined, selectedId: string | null): InstructionFile | null;
export function splitFrontmatter(markdown: string | null | undefined): { frontmatter: string | null; body: string };
export function sectionMatchesFile(section: { kind: string; id?: string | null }, fileId: string | null): boolean;
export function composedSections(instructions: PanelInstructions | null | undefined, selectedId: string | null): Array<{ kind: string; id: string | null; title: string; text: string; selected: boolean }>;
export function copyPayload(instructions: PanelInstructions | null | undefined, selectedId: string | null, mode: string): string;
export function rawCaption(file: Pick<InstructionFile, "path" | "rawDiff"> | null | undefined): string;

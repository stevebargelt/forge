// FG-830: types for the Notes view's pure rules (client/notes-render.js).

export interface NotesEntry {
  checkoutDir: string;
  checkoutBranch?: string | null;
  notes: string;
  modifiedAt?: string | null;
}
export interface NoteSession {
  iso: string | null;
  source: "note" | "modified" | "unknown";
}
export interface NoteRow {
  checkoutDir: string;
  label: string;
  branch: string | null;
  primary: boolean;
  notes: string;
  session: NoteSession;
  sessionMs: number | null;
  preview: string;
  href: string;
}
type Scope = { project?: string | null; checkout?: string | null } | null | undefined;
type Projects = readonly { key: string; primaryCheckout?: string; checkouts?: readonly { projectDir: string; projectDirs?: readonly string[]; branch?: string | null; exists?: boolean }[] }[] | null | undefined;

export const NO_PROJECT_MESSAGE: string;
export const NO_NOTES_MESSAGE: string;
export function lastSessionDate(notes: string | null | undefined): string | null;
export function sessionOf(entry: { notes?: string | null; modifiedAt?: string | null } | null | undefined): NoteSession;
export function sessionDisplay(session: NoteSession, now?: number): { text: string; title: string };
export function notePreview(notes: string | null | undefined, max?: number): string;
export function scopedProject(scope: Scope, projects: Projects): { key: string; primaryCheckout?: string } | null;
export function noteRows(data: { notesByCheckout?: readonly NotesEntry[] } | null | undefined, scope: Scope, projects: Projects): NoteRow[];
export function noteRowFor(rows: readonly NoteRow[], checkoutDir: string | null | undefined): NoteRow | null;

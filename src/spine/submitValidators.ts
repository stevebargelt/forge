// Validators for `forge submit` (FORGE-DEC-016). Manual phases capture human-produced
// artifacts via this layer — each workflow that uses a manual phase has its own
// validator that checks the artifacts exist + look right before the task transitions
// to awaiting_gate.
//
// Today ui-design, ui-design-revise, and feature-ui-design-needed have manual
// phases. Each new manual-phase workflow adds another validator here and a
// switch arm in submit.ts.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type UiDesignArtifacts = {
  penFile: string;
  pngFiles: string[];
  htmlFiles: string[];
};

// Find the canonical .pen file in designDir. Per #82, with shared-corpus reuse
// (#67) the .pen filename is meaningful (e.g. `dashboard.pen`), not derived from
// designDir basename. So glob *.pen instead of expecting a fixed name.
//
// Rules:
//   - Exactly one .pen → use it (even when its name doesn't match basename)
//   - Zero .pen → error ("did Pencil save?")
//   - Multiple .pen → error with file list (ambiguous; human must clean up)
//   - The matched .pen must be non-zero (Pencil's "saved 0 bytes" failure mode)
//
// `runTitle` is no longer used for slug derivation but kept in the signature
// for callers; left undocumented so existing code keeps compiling. Future
// cleanup: drop the param if no caller depends on it.
export function validateUiDesignArtifacts(
  designDir: string,
  _runTitle: string
): UiDesignArtifacts {
  if (!existsSync(designDir)) {
    throw new Error(`Design directory does not exist: ${designDir}`);
  }
  const penNames = readdirSync(designDir).filter((f) => f.toLowerCase().endsWith(".pen"));
  if (penNames.length === 0) {
    throw new Error(
      `No .pen file found in ${designDir}. Did Pencil save the design source? (Cmd+S in VS Code with the Pencil extension active.)`
    );
  }
  if (penNames.length > 1) {
    throw new Error(
      `Multiple .pen files found in ${designDir}: ${penNames.join(", ")}. Forge submit expects exactly one canonical Pencil source per design corpus. Move or delete the extras and re-submit.`
    );
  }
  const penFile = join(designDir, penNames[0]!);
  if (statSync(penFile).size === 0) {
    throw new Error(
      `Pencil source at ${penFile} is empty (0 bytes). Pencil 0.2.5 requires a manual Cmd+S in VS Code to persist; auto-save isn't shipped yet.`
    );
  }

  const designsDir = join(designDir, "designs");
  if (!existsSync(designsDir)) {
    throw new Error(
      `Expected ${designsDir} to exist with at least one PNG. Did the export step run?`
    );
  }
  const pngFiles = readdirSync(designsDir)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .map((f) => join(designsDir, f))
    .sort();
  if (pngFiles.length === 0) {
    throw new Error(
      `No PNG files found in ${designsDir}. The export_nodes step in PROMPT.md should have produced at least one.`
    );
  }

  const codeDir = join(designDir, "code");
  if (!existsSync(codeDir)) {
    throw new Error(
      `Expected ${codeDir} to exist with at least one HTML file. Did the code-export step run?`
    );
  }
  const htmlFiles = readdirSync(codeDir)
    .filter((f) => f.toLowerCase().endsWith(".html"))
    .map((f) => join(codeDir, f))
    .sort();
  if (htmlFiles.length === 0) {
    throw new Error(
      `No HTML files found in ${codeDir}. The HTML+Tailwind code-export step in PROMPT.md should have produced at least one.`
    );
  }

  return { penFile, pngFiles, htmlFiles };
}

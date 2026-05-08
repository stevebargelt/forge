// Validators for `forge submit` (FORGE-DEC-016). Manual phases capture human-produced
// artifacts via this layer — each workflow that uses a manual phase has its own
// validator that checks the artifacts exist + look right before the task transitions
// to awaiting_gate.
//
// Today only ui-design / design-revise have manual phases. Each new manual-phase
// workflow adds another validator here and a switch arm in submit.ts.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sanitizeTitleForFilename } from "../util/paths.js";

export type UiDesignArtifacts = {
  penFile: string;
  pngFiles: string[];
  htmlFiles: string[];
};

// Validates the conventional ui-design artifact layout under designDir:
//   <designDir>/<sanitized-title>.pen   (Pencil source, non-zero)
//   <designDir>/designs/*.png           (rendered screens, ≥1)
//   <designDir>/code/*.html             (HTML/Tailwind exports, ≥1)
// Throws a descriptive error naming the failed check + path. The human re-runs
// Pencil or fixes the export and re-submits — these errors are the "Pencil didn't
// save" / "code-export step skipped" failure catchers.
export function validateUiDesignArtifacts(
  designDir: string,
  runTitle: string
): UiDesignArtifacts {
  const slug = sanitizeTitleForFilename(runTitle);
  const penFile = join(designDir, `${slug}.pen`);

  if (!existsSync(penFile)) {
    throw new Error(
      `Pencil source not found at ${penFile}. Did Pencil save the .pen file? (Cmd+S in VS Code with the Pencil extension active.)`
    );
  }
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

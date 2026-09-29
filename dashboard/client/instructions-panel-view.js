// FG-827: the Instructions tab — a Files panel (every composition source, in order, the
// seed CLAUDE.md marked ENTRY) beside a viewer with Read (rendered Markdown), Raw and
// Composed (the exact bytes a container receives, sections marked, with their sha256)
// modes and a copy button. No Edit: the viewer names the path to change and that
// `forge upgrade` publishes it. Decisions live in instructions-panel-render.js.

import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { md } from "./markdown.js";
import {
  INSTRUCTION_MODES, composedSections, copyPayload, defaultFileId, instructionFileRows, kindLabel, rawCaption, selectedFile, splitFrontmatter,
} from "./instructions-panel-render.js";

const html = htm.bind(h);

function CopyButton({ text }) {
  const [state, setState] = useState("idle");
  const onClick = () => {
    const done = (ok) => { setState(ok ? "copied" : "failed"); setTimeout(() => setState("idle"), 1500); };
    if (!navigator.clipboard?.writeText) return done(false);
    navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
  };
  return html`
    <button type="button" class="instr-copy" data-copy-bytes=${text.length} onClick=${onClick} aria-label="Copy to clipboard">
      ${state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  `;
}

export function InstructionsPanel({ i }) {
  const [fileId, setFileId] = useState(() => defaultFileId(i));
  const [mode, setMode] = useState("read");
  if (!i.ok) {
    return html`
      <div class="role-instructions">
        <p class="muted">Composed as ${i.context}.</p>
        <div class="card" style="color: var(--err);" role="alert" data-refusal>Dispatch would refuse this role: ${i.refusal}</div>
      </div>
    `;
  }
  const file = selectedFile(i, fileId);
  const rows = instructionFileRows(i, file?.id ?? null);
  return html`
    <div class="role-instructions">
      <p class="muted">Composed as ${i.context}. Content hash <span class="mono" data-prompt-sha>${i.sha256}</span>.</p>
      ${i.constraintsSkipped.length > 0 ? html`<p class="muted">Constraints toggled off: ${i.constraintsSkipped.map((s) => `${s.id} (${s.reason})`).join(", ")}</p>` : null}
      <div class="instr-layout">
        <nav class="instr-files" aria-label="Instruction files">
          <div class="instr-files-head">Files <span class="faint">in composition order</span></div>
          <ul>
            ${rows.map((r) => html`
              <li key=${r.id}>
                <button type="button" class=${"instr-file" + (r.selected ? " instr-file-selected" : "")} data-file=${r.id} data-kind=${r.kind}
                  aria-pressed=${r.selected ? "true" : "false"} onClick=${() => setFileId(r.id)}>
                  <span class="mono instr-file-name">${r.label}</span>
                  <span class=${"instr-kind" + (r.entry ? " instr-kind-entry" : "")}>${r.badge}</span>
                </button>
              </li>
            `)}
          </ul>
        </nav>
        <section class="instr-viewer" aria-label="Instruction viewer">
          <div class="instr-viewer-head">
            <div class="instr-viewer-title">
              ${mode === "composed"
                ? html`<span class="mono">Composed prompt</span><span class="faint">${i.prompt.length} chars · sha256 ${i.sha256}</span>`
                : html`<span class="mono" data-viewer-file=${file?.id}>${file?.label}</span><span class="faint">${kindLabel(file?.kind)} · ${file?.path ?? "not a file"}</span>`}
            </div>
            <div class="instr-modes" role="group" aria-label="View mode">
              ${INSTRUCTION_MODES.map((m) => html`
                <button key=${m.id} type="button" class=${"instr-mode" + (mode === m.id ? " instr-mode-current" : "")} data-mode=${m.id}
                  aria-pressed=${mode === m.id ? "true" : "false"} onClick=${() => setMode(m.id)}>${m.label}</button>
              `)}
            </div>
            <${CopyButton} text=${copyPayload(i, file?.id ?? null, mode)} />
          </div>
          ${mode === "composed" ? html`
            <div class="instr-composed" data-view="composed">
              ${composedSections(i, file?.id ?? null).map((s, n) => html`
                <section key=${n} class=${`role-prompt-section role-prompt-${s.kind}` + (s.selected ? " role-prompt-selected" : "")} data-section=${s.kind} data-constraint=${s.id ?? undefined}>
                  <div class="role-prompt-label">${s.title}</div>
                  <pre class="role-prompt">${s.text}</pre>
                </section>
              `)}
            </div>
          ` : mode === "raw" ? html`
            <pre class="role-prompt instr-raw" data-view="raw">${file?.markdown ?? ""}</pre>
            ${file?.raw !== undefined ? html`
              <figure class="instr-disk" data-view="disk">
                <figcaption class="faint" data-disk-caption>${rawCaption(file)}</figcaption>
                <pre class="role-prompt instr-raw">${file.raw}</pre>
              </figure>
            ` : null}
          ` : html`<${ReadView} markdown=${file?.raw ?? file?.markdown ?? ""} />`}
          ${file && mode !== "composed" ? html`<p class="instr-edit muted" data-edit>Read-only here. To change it: ${file.edit}.</p>` : null}
        </section>
      </div>
    </div>
  `;
}

function ReadView({ markdown }) {
  const { frontmatter, body } = splitFrontmatter(markdown);
  return html`
    <div class="instr-read" data-view="read">
      ${frontmatter !== null ? html`<pre class="role-prompt instr-frontmatter" data-frontmatter>${frontmatter}</pre>` : null}
      <div class="md instr-md" dangerouslySetInnerHTML=${{ __html: md(body, { html: "text" }) }}></div>
    </div>
  `;
}

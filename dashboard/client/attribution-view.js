// FG-845: Setup › Config's git-attribution controls card (and its stale-block notice),
// and the Projects card's attribution line. The controls post to the closed attribution
// routes (`forge config set|unset ai-attribution`, action-mutation.ts) — never a file
// write. Preview shows the exact verb and the file it changes; Confirm runs it, then the
// Config row and the Projects cards re-read and focus returns to the group (FG-692).

import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { postJson } from "./raci-editor-view.js";
import { badgeClass } from "./status-tokens.js";
import { checkoutLabelForDir } from "./checkout-label.js";
import {
  HOST_CHOICES,
  PROJECT_CHOICES,
  attributionCommand,
  attributionTag,
  attributionTargetFile,
  confirmOutcome,
  currentHostChoice,
  currentProjectChoice,
  inheritCount,
  segmentStep,
} from "./attribution-render.js";

const html = htm.bind(h);

export function AttributionTag({ view }) {
  const tag = attributionTag(view);
  if (tag.key === "fail_closed") return html`<span class=${badgeClass("attribution", "fail_closed") + " attr-tag"} data-attr-tag=${tag.key}>${tag.label}</span>`;
  return html`<span class=${"attr-tag" + (tag.key === "project" ? " attr-tag-src" : "")} data-attr-tag=${tag.key}>${tag.label}</span>`;
}

/** FG-845: the Projects card's one line — the same object the Config row reads. */
export function ProjectAttributionLine({ view }) {
  if (!view) return null;
  const failed = Boolean(view.reason);
  return html`
    <div class=${"project-attr" + (failed ? " project-attr-failed" : "")} data-project-attr=${view.mode}>
      Git attribution: <span class="mono">${view.mode}</span> <${AttributionTag} view=${view} />
      ${failed
        ? html` <span class="faint" title=${view.reason}>· ${failedFileLabel(view)} has an unrecognized value — fix it ${view.file === view.hostFile ? "in the host file" : "in the checkout"}</span>`
        : !view.host && view.source === "default"
          ? html` <span class="faint">· no host value</span>`
          : null}
    </div>
  `;
}

function failedFileLabel(view) {
  if (!view.file) return "a config value";
  return view.file.startsWith(`${view.checkout}/`) ? view.file.slice(view.checkout.length + 1) : view.file;
}

function checkoutText(dir, projects) {
  return checkoutLabelForDir(dir, projects) || dir;
}

function projectForCheckout(dir, projects) {
  return (projects ?? []).find((p) => (p.checkouts ?? []).some((c) => c.projectDir === dir)) ?? null;
}

export function AttributionControls({ view, scope, projects, onChanged }) {
  const project = (scope?.project && (projects ?? []).find((p) => p.key === scope.project)) || projectForCheckout(view.checkout, projects);
  const counts = inheritCount(projects);
  return html`
    <section class="workbench-section cp-attr" role="region" aria-label="Git attribution controls">
      <h3 class="cp-attr-title">Git attribution</h3>
      <div class="muted cp-attr-caption">
        Whether commits and PRs made for this project may carry AI attribution trailers. A change is an explicit act:
        it previews the exact <span class="mono">forge config</span> verb, then Confirm runs it — never a direct file write.
      </div>
      <div class="cp-attr-controls">
        <${AttributionControl}
          target="project"
          title="This project"
          pill=${checkoutText(view.checkout, projects)}
          choices=${PROJECT_CHOICES}
          current=${currentProjectChoice(view)}
          view=${view}
          body=${project ? { projectKey: project.key, projectDir: view.checkout } : null}
          disabledReason=${project ? null : "This checkout is not a registered project, so it has no project value to change here."}
          onChanged=${onChanged}
        />
        <${AttributionControl}
          target="host"
          title="Host default"
          pill=${view.hostFile}
          choices=${HOST_CHOICES}
          current=${currentHostChoice(view)}
          view=${view}
          body=${{}}
          disabledReason=${null}
          onChanged=${onChanged}
          footer=${`Applies to every project without its own value (${counts.inherit} of ${counts.total} inherit).`}
        />
      </div>
      ${view.renderedBlock === "stale"
        ? html`<div class="cp-attr-stale" role="status" data-attr-stale>
            ⚠ <b>Rendered orchestrator block is stale for this checkout</b> — CLAUDE.md still says
            ${" "}<span class="mono">${view.renderedMode ?? "neither mode"}</span> while the resolved value is
            ${" "}<span class="mono">${view.mode}</span>. The git hook and the constraint already read the live value; run
            ${" "}<span class="mono">forge upgrade</span> in the checkout to re-render the block.
          </div>`
        : null}
    </section>
  `;
}

function AttributionControl({ target, title, pill, choices, current, view, body, disabledReason, onChanged, footer = null }) {
  const values = choices.map((c) => c.value);
  const [choice, setChoice] = useState(current ?? values[0]);
  const [stage, setStage] = useState("idle");
  const [result, setResult] = useState(null);
  const groupRef = useRef(null);
  useEffect(() => {
    if (current) setChoice(current);
  }, [current]);

  const focusChoice = (value) => {
    const button = groupRef.current?.querySelector(`[data-choice="${value}"]`);
    if (button) button.focus();
  };
  const pick = (value) => {
    setChoice(value);
    setStage("idle");
    setResult(null);
  };
  const onKeyDown = (event) => {
    const next = segmentStep(values, choice, event.key);
    if (next === null) return;
    event.preventDefault();
    pick(next);
    focusChoice(next);
  };
  const command = attributionCommand(target, choice);
  const unchanged = choice === current;
  const confirm = async () => {
    setStage("running");
    setResult(await confirmOutcome(() => postJson(`/api/ai-attribution/${target}`, { ...body, mode: choice }), command));
    setStage("idle");
    if (onChanged) await onChanged();
    focusChoice(choice);
  };
  const onEscape = (event) => {
    if (event.key !== "Escape" || stage !== "preview") return;
    event.preventDefault();
    event.stopPropagation();
    setStage("idle");
    focusChoice(choice);
  };
  const disabled = disabledReason !== null;
  return html`
    <div class="cp-attr-ctl" data-attr-control=${target} onKeyDown=${onEscape}>
      <h4 class="cp-attr-ctl-title">${title} <span class="cp-attr-pill mono">${pill}</span></h4>
      <div class="cp-seg" role="group" aria-label=${`${title}: git attribution`} ref=${groupRef} onKeyDown=${onKeyDown}>
        ${choices.map((c) => html`
          <button
            type="button"
            key=${c.value}
            class=${"cp-seg-btn" + (choice === c.value ? " cp-seg-on" : "")}
            data-choice=${c.value}
            aria-pressed=${choice === c.value ? "true" : "false"}
            tabindex=${choice === c.value ? 0 : -1}
            disabled=${disabled}
            onClick=${() => pick(c.value)}
          >${c.label}${current === c.value ? html`<span class="sr-only"> (current)</span>` : null}</button>
        `)}
      </div>
      ${disabled
        ? html`<div class="muted cp-attr-note">${disabledReason}</div>`
        : html`
          <div class="mono cp-attr-verb" data-attr-verb>
            → ${command}${target === "project" && choice !== "inherit" ? html` <span class="faint">(inherit = forge config unset ai-attribution)</span>` : null}
          </div>
          ${stage === "preview"
            ? html`<div class="cp-attr-preview" data-attr-preview>
                runs <span class="mono">${command}</span> as <span class="mono">dashboard</span>; changes
                ${" "}<span class="mono">${attributionTargetFile(target, view)}</span>
              </div>`
            : null}
          <div class="row cp-attr-actions" style="gap: 8px;">
            <button type="button" class="cp-attr-btn" data-attr-action="preview" disabled=${unchanged || stage === "running"} onClick=${() => setStage("preview")}>Preview</button>
            <button type="button" class="cp-attr-btn cp-attr-confirm" data-attr-action="confirm" disabled=${stage !== "preview"} onClick=${confirm}>
              ${stage === "running" ? "Running…" : "Confirm"}
            </button>
            ${unchanged ? html`<span class="faint cp-attr-note">current value</span>` : null}
          </div>
        `}
      <div aria-live="polite" class=${"cp-attr-result" + (result && !result.ok ? " cp-warn" : "")} data-attr-result data-attr-outcome=${result?.kind ?? null}>${result ? result.text : ""}</div>
      ${footer ? html`<div class="faint cp-attr-note" data-attr-inherit>${footer}</div>` : null}
    </div>
  `;
}


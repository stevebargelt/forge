// FG-838: the one info affordance beside a list view's title. The static screen contract
// (FG-821's three answers and the CLI verb) lives here instead of under every title: a
// 20px "?" button whose hover/focus tooltip names what the page shows, and whose click,
// Enter or Space opens a popover with all three answers and the verb to copy. Everything
// in the tooltip is also in the popover, so nothing is hover-only (FG-692).

import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { listHeader } from "./screen-header-render.js";

const html = htm.bind(h);

function CopyVerb({ verb }) {
  const [state, setState] = useState("idle");
  const onClick = () => {
    const done = (ok) => { setState(ok ? "copied" : "failed"); setTimeout(() => setState("idle"), 1500); };
    if (!navigator.clipboard?.writeText) return done(false);
    navigator.clipboard.writeText(verb).then(() => done(true), () => done(false));
  };
  return html`
    <button type="button" class="info-tip-copy" onClick=${onClick} aria-label=${`Copy ${verb}`}>
      ${state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  `;
}

/** The popover's content: the three answers, then the verb as code with its Copy button.
 *  Hook-free apart from CopyVerb, so its text is unit-testable. */
export function InfoTipAnswers({ header }) {
  return html`
    <dl class="info-tip-answers">
      <dt>What is happening</dt><dd data-answer="happening">${header.happening}</dd>
      <dt>Does it need me</dt><dd data-answer="needs">${header.needs}</dd>
      <dt>What do I do</dt><dd data-answer="todo">${header.todo}</dd>
    </dl>
    ${header.verb ? html`
      <p class="info-tip-verb"><code class="screen-verb" data-verb>${header.verb}</code> <${CopyVerb} verb=${header.verb} /></p>
    ` : null}
  `;
}

export function InfoTip({ view, title }) {
  const header = listHeader(view);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => { setOpen(false); }, [view]);

  // A layout effect, so focus and the click-outside listener are live as soon as the
  // popover is painted.
  useLayoutEffect(() => {
    if (!open) return undefined;
    popRef.current?.focus();
    const onPointer = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  if (!header) return null;
  const tipId = `info-tip-${view}-tooltip`;
  const popId = `info-tip-${view}-popover`;
  const onKeyDown = (e) => {
    if (e.key !== "Escape" || !open) return;
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    buttonRef.current?.focus();
  };
  return html`
    <span class="info-tip" ref=${wrapRef} onKeyDown=${onKeyDown} data-info-tip=${view}>
      <button
        type="button"
        class="info-tip-button"
        ref=${buttonRef}
        aria-label=${`About ${title}`}
        aria-expanded=${open ? "true" : "false"}
        aria-controls=${popId}
        aria-describedby=${tipId}
        onClick=${() => setOpen(!open)}
      >?</button>
      <span class="info-tip-tooltip" role="tooltip" id=${tipId}>${header.happening}</span>
      <div
        class="info-tip-popover"
        id=${popId}
        role="dialog"
        aria-label=${`About ${title}`}
        tabindex="-1"
        ref=${popRef}
        hidden=${!open}
      >
        <${InfoTipAnswers} header=${header} />
      </div>
    </span>
  `;
}

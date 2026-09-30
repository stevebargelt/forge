// FG-821: the pieces every object page (run, task, Explain, ticket, review) shares — the
// breadcrumb trail, the one-line screen contract, the tab strip and Escape-to-parent. It
// adds no decisions: breadcrumbs-render.js builds the trail and screen-header-render.js
// the copy.

import { h } from "preact";
import { useLayoutEffect } from "preact/hooks";
import htm from "htm";
import { screenLineText } from "./screen-header-render.js";

const html = htm.bind(h);

export function Breadcrumbs({ crumbs }) {
  return html`
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        ${crumbs.map((crumb, i) => html`
          <li key=${`${crumb.kind}-${i}`} data-crumb=${crumb.kind}>
            ${crumb.href
              ? html`<a href=${crumb.href}>${crumb.label}</a>`
              : html`<span aria-current="page">${crumb.label}</span>`}
          </li>
        `)}
      </ol>
    </nav>
  `;
}

/** The screen contract in one short line: H · N · D, and the CLI verb as code. */
export function ScreenLine({ header }) {
  const text = screenLineText(header);
  if (text === "") return null;
  const parts = [header.happening, header.needs, header.todo].filter((s) => typeof s === "string" && s !== "");
  return html`
    <p class=${"screen-line" + (header.needsYou ? " screen-line-needs" : "")} data-screen-line=${text}>
      ${parts.join(" · ")}${header.verb ? html`: <code class="screen-verb">${header.verb}</code>` : null}
    </p>
  `;
}

/** An object page's head: the trail, then the title, then the screen line — with the
 *  page's action buttons (FG-822), when it has any, on the "what do I do" line. */
export function ObjectHead({ crumbs, title, header, actions = null, children }) {
  return html`
    <div class="page-head object-head">
      <${Breadcrumbs} crumbs=${crumbs} />
      <h1 class="page-title">${title}</h1>
      ${children}
    </div>
    <${ScreenLine} header=${header} />
    ${actions}
  `;
}

/** Object tabs: links (so reload and open-in-new-tab work) in the tablist pattern —
 *  arrow keys move between them. Only the current tab's content is rendered, so every tab
 *  controls the one tabpanel, which is labelled by the current tab. */
export function ObjectTabs({ id, label, tabs, children }) {
  const onKeyDown = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const links = [...e.currentTarget.querySelectorAll("[role=tab]")];
    const at = links.indexOf(document.activeElement);
    if (at === -1) return;
    e.preventDefault();
    const next = links[(at + (e.key === "ArrowRight" ? 1 : links.length - 1)) % links.length];
    next.focus();
    next.click();
  };
  const panelId = `${id}-panel`;
  const tabId = (tab) => `${id}-tab-${tab.id}`;
  const current = tabs.find((tab) => tab.current) ?? tabs[0];
  return html`
    <div class="object-tabs" role="tablist" aria-label=${label} onKeyDown=${onKeyDown}>
      ${tabs.map((tab) => html`
        <a
          key=${tab.id}
          id=${tabId(tab)}
          role="tab"
          class=${"object-tab" + (tab.current ? " object-tab-current" : "")}
          href=${tab.href}
          aria-selected=${tab.current ? "true" : "false"}
          aria-controls=${panelId}
          tabindex=${tab.current ? "0" : "-1"}
          data-tab=${tab.id}
        >${tab.label}</a>
      `)}
    </div>
    <div class="object-tabpanel" id=${panelId} role="tabpanel" aria-labelledby=${tabId(current)}>
      ${children}
    </div>
  `;
}

/** Escape on an object page navigates to its parent. A key already handled (the nav
 *  drawer's own Escape), a key typed into a field, or an open modal is left alone.
 *  Registered in a layout effect so the listener is live as soon as the page is painted. */
export function useEscapeTo(parentHash) {
  useLayoutEffect(() => {
    if (!parentHash) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target;
      if (target && typeof target.closest === "function" && target.closest("input, textarea, select, [aria-modal='true']")) return;
      if (document.querySelector("[aria-modal='true']")) return;
      e.preventDefault();
      window.location.hash = parentHash;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [parentHash]);
}

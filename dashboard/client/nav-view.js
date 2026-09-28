// FG-820: the left-column navigation, the compact bottom bar and the drawer that holds
// the column below the 720px nav breakpoint. It adds NO decisions: nav-render.js decides
// the items, hrefs, current item and the Home badge; view-routing.js owns the hashes.
//
// Every nav item is an <a href="#…"> link, so Tab / Enter / open-in-new-tab work
// natively; group headings are plain headings, not controls. The only buttons are the
// scope control's, More, and the drawer's close.

import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { BOTTOM_BAR_ITEMS, checkoutScopeLabel, homeBadge, navHref, navModel } from "./nav-render.js";
import { ROUTES } from "./view-routing.js";

const html = htm.bind(h);

function NavBadge({ badge }) {
  if (!badge) return null;
  const cls = `nav-badge nav-badge-${badge.tone}${badge.partial ? " nav-badge-partial" : ""}`;
  return html`
    <span class=${cls} aria-hidden="true" title=${badge.label}>${badge.text}${badge.partial ? html`<span class="nav-badge-mark">*</span>` : null}</span>
    <span class="nav-sr-only">(${badge.label})</span>
  `;
}

function ScopeControl({ scope, projects, onScopeChange, idPrefix }) {
  const project = scope.project ? projects.find((p) => p.key === scope.project) ?? null : null;
  const known = scope.project === null || project !== null;
  const checkouts = project?.checkouts || [];
  const selectId = `${idPrefix}-scope-project`;
  return html`
    <div class="nav-scope" role="group" aria-label="Project scope">
      <label class="nav-scope-label" for=${selectId}>Scope</label>
      <select
        id=${selectId}
        class="nav-scope-select"
        value=${scope.project ?? ""}
        onChange=${(e) => onScopeChange({ project: e.target.value || null, checkout: null })}
      >
        <option value="">All projects</option>
        ${known ? null : html`<option value=${scope.project}>${scope.project}</option>`}
        ${projects.map((p) => html`<option key=${p.key} value=${p.key}>${p.label}</option>`)}
      </select>
      ${scope.project && checkouts.length > 0 ? html`
        <div class="project-scope-options" aria-label="Project checkout scope">
          <button
            type="button"
            class=${"checkout-scope-btn" + (!scope.checkout ? " checkout-scope-btn-active" : "")}
            onClick=${() => onScopeChange({ project: scope.project, checkout: null })}
            aria-pressed=${!scope.checkout}
          >all checkouts</button>
          ${checkouts.map((checkout) => html`
            <button
              type="button"
              key=${checkout.projectDir}
              class=${"checkout-scope-btn" + (scope.checkout === checkout.projectDir ? " checkout-scope-btn-active" : "")}
              onClick=${() => onScopeChange({ project: scope.project, checkout: checkout.projectDir })}
              aria-pressed=${scope.checkout === checkout.projectDir}
              title=${checkout.projectDir}
            >${checkoutScopeLabel(checkout)}</button>
          `)}
        </div>
      ` : null}
      ${scope.project ? html`<button type="button" class="clear-filter" onClick=${() => onScopeChange({ project: null, checkout: null })}>clear ×</button>` : null}
    </div>
  `;
}

/** The full column: brand, scope control, the five groups, and the last-poll clock. */
export function NavColumn({ view, scope, projects, onScopeChange, now, inboxLoad, idPrefix = "nav" }) {
  const badge = homeBadge(inboxLoad);
  return html`
    <div class="nav-brand">
      <img src="/client/logo-mark.svg" width="28" height="28" class="brand-mark" alt="forge" />
      <span aria-hidden="true">forge</span>
    </div>
    <${ScopeControl} scope=${scope} projects=${projects} onScopeChange=${onScopeChange} idPrefix=${idPrefix} />
    <nav class="nav-groups" aria-label="Dashboard">
      ${navModel(view, scope).map((group) => html`
        <section key=${group.id} class="nav-group" aria-labelledby=${`${idPrefix}-group-${group.id}`}>
          <h2 class="nav-group-heading" id=${`${idPrefix}-group-${group.id}`}>${group.label}</h2>
          <ul class="nav-list">
            ${group.items.map((item) => html`
              <li key=${item.view}>
                <a
                  class=${"nav-item" + (item.current ? " nav-item-current" : "")}
                  href=${item.href}
                  aria-current=${item.current ? "page" : undefined}
                  data-view=${item.view}
                >
                  <span class="nav-item-label">${item.label}</span>
                  ${item.view === "home" ? html`<${NavBadge} badge=${badge} />` : null}
                </a>
              </li>
            `)}
          </ul>
        </section>
      `)}
    </nav>
    <div class="nav-clock muted mono" title="Last poll">${new Date(now).toLocaleTimeString()}</div>
  `;
}

/** The five-slot bar below 720px: Home, Runs, Queue, Backlog, More. */
export function BottomBar({ view, current, scope, inboxLoad, drawerOpen, onOpenDrawer, moreRef }) {
  const badge = homeBadge(inboxLoad);
  return html`
    <nav class="bottom-bar" aria-label="Dashboard shortcuts">
      ${BOTTOM_BAR_ITEMS.map((item) => html`
        <a
          key=${item}
          class=${"bottom-bar-item" + (item === current ? " bottom-bar-item-current" : "")}
          href=${navHref(item, scope)}
          aria-current=${item === current ? "page" : undefined}
          data-view=${item}
        >
          <span class="nav-item-label">${ROUTES[item].label}</span>
          ${item === "home" ? html`<${NavBadge} badge=${badge} />` : null}
        </a>
      `)}
      <button
        type="button"
        ref=${moreRef}
        class=${"bottom-bar-item bottom-bar-more" + (current && !BOTTOM_BAR_ITEMS.includes(current) ? " bottom-bar-item-current" : "")}
        aria-haspopup="dialog"
        aria-expanded=${drawerOpen}
        aria-controls="nav-drawer"
        onClick=${onOpenDrawer}
        data-view=${view}
      >More</button>
    </nav>
  `;
}

const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The drawer: a modal dialog holding the full column. Focus is trapped inside, Escape
 *  closes it, and focus returns to More when it closes. */
export function NavDrawer({ onClose, returnFocusRef, children }) {
  const panelRef = useRef(null);
  useEffect(() => {
    panelRef.current?.querySelector(".nav-drawer-close")?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = [...panelRef.current.querySelectorAll(FOCUSABLE)];
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  // Following a link closes the drawer even when it names the page already shown (no
  // hashchange fires then).
  const onClick = (e) => {
    if (e.target.closest("a[href]")) onClose();
  };
  return html`
    <div class="nav-drawer-backdrop" onClick=${onClose}></div>
    <div id="nav-drawer" class="nav-drawer" role="dialog" aria-modal="true" aria-label="Navigation" ref=${panelRef} onKeyDown=${onKeyDown} onClick=${onClick}>
      <div class="nav-drawer-head">
        <span class="muted">Navigation</span>
        <button type="button" class="nav-drawer-close" aria-label="Close navigation" onClick=${onClose}>×</button>
      </div>
      ${children}
    </div>
  `;
}

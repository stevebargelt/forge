// FG-846 — AN ACTION'S OUTCOME, AT THE POINT OF ACTION.
//
// The placement rule, reusable by every action registry on this surface (the Queue's
// enqueue/dequeue/rank today; the FG-822 task actions and the FG-834/835 governance
// applies can adopt it):
//
//  * The outcome element renders as the NEXT SIBLING of the control that triggered it
//    (placeOutcome) — the CLI's refusal text verbatim, or the applied result.
//  * role="alert" for a refusal, role="status" for an applied result (outcomeRole).
//  * Focus moves to it on arrival. If the element remounts (the board re-read and the card
//    moved lanes), it reclaims focus only when focus was lost to the page.
//  * Escape returns focus to the control — the element's previous sibling, by construction —
//    unless the caller names another `returnFocus` (a reorder's control is its card).
//  * It persists until the next board reload (the ledger is reset) or a later outcome on the
//    same key, which replaces it. A refusal also leaves a compact pill on its ticket until the
//    reload or a later success for that ticket (pillFor) — dismissing the outcome keeps it.
//    That later success also retires the ticket's refusals under other keys.
//
// The ledger is plain data so the persistence and replacement rules are unit-tested without
// a DOM (src/fg846-action-outcome.test.ts).

import { h } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

/** `alert` for anything that did not apply; `status` for an applied result. */
export function outcomeRole(outcome) {
  return outcome && outcome.ok === true ? "status" : "alert";
}

// ─── the ledger ──────────────────────────────────────────────────────────────

let nextId = 0;

/** A fresh ledger — what a board reload resets to. */
export function emptyOutcomes() {
  return { byKey: {}, pills: {} };
}

/** Record an outcome against the key of the control that produced it. It REPLACES
 *  whatever that key held. `ticketId` (optional) carries the pill rule: a refusal sets the
 *  ticket's pill; a success clears it, and retires that ticket's refusals still showing
 *  under other keys (a refusal saved away from the controls block no longer describes
 *  the card). */
export function recordOutcome(ledger, key, outcome) {
  const entry = { ...outcome, key, id: ++nextId, at: outcome.at ?? Date.now(), dismissed: false };
  const pills = { ...ledger.pills };
  const byKey = { ...ledger.byKey };
  if (entry.ticketId) {
    if (entry.ok) {
      delete pills[entry.ticketId];
      for (const [other, held] of Object.entries(byKey)) {
        if (held.ticketId === entry.ticketId && !held.ok) byKey[other] = { ...held, dismissed: true };
      }
    } else {
      pills[entry.ticketId] = { verdict: entry.verdict ?? null, at: entry.at, outcome: entry };
    }
  }
  byKey[key] = entry;
  return { byKey, pills };
}

/** Patch the outcome a key holds (e.g. open its Refine panel) without re-announcing it. */
export function updateOutcome(ledger, key, patch) {
  const current = ledger.byKey[key];
  if (!current) return ledger;
  return { ...ledger, byKey: { ...ledger.byKey, [key]: { ...current, ...patch } } };
}

/** Hide a key's outcome. The ticket's pill stays: it is cleared only by a reload or a
 *  later success. */
export function dismissOutcome(ledger, key) {
  return updateOutcome(ledger, key, { dismissed: true });
}

/** The outcome to render beside a key's control, or null. */
export function outcomeFor(ledger, key) {
  const entry = ledger.byKey[key];
  return entry && !entry.dismissed ? entry : null;
}

/** The compact refusal pill a ticket carries, or null. */
export function pillFor(ledger, ticketId) {
  return ledger.pills[ticketId] ?? null;
}

// ─── focus ───────────────────────────────────────────────────────────────────

const announced = new Set();

/** Whether an outcome element should take focus now: on its first arrival — unless focus
 *  is already inside it (a panel it opened with focused its own field) — and on a later
 *  remount only when focus was lost to the page (nothing, or <body>, is active).
 * @param {number} id
 * @param {any} activeElement
 * @param {any} [el]
 */
export function shouldTakeFocus(id, activeElement, el = null) {
  const inside = Boolean(el && activeElement && activeElement !== el && typeof el.contains === "function" && el.contains(activeElement));
  if (!announced.has(id)) {
    announced.add(id);
    return !inside;
  }
  return !activeElement || activeElement.tagName === "BODY";
}

/** Escape's target: the caller's `returnFocus`, else the outcome's previous sibling — the
 *  control that triggered it. Returns the element focused, or null.
 * @param {any} outcomeEl
 * @param {((el: any) => any) | null} [returnFocus]
 */
export function returnFocusToControl(outcomeEl, returnFocus = null) {
  const target = returnFocus ? returnFocus(outcomeEl) : outcomeEl?.previousElementSibling ?? null;
  if (target && typeof target.focus === "function") {
    target.focus();
    return target;
  }
  return null;
}

/** The keydown handler an outcome element carries. A panel inside it that handles Escape
 *  itself calls preventDefault, and this then leaves the key alone.
 * @param {any} e
 * @param {((el: any) => any) | null} [returnFocus]
 */
export function outcomeKeyDown(e, returnFocus = null) {
  if (e.key !== "Escape" || e.defaultPrevented) return false;
  e.preventDefault();
  returnFocusToControl(e.currentTarget, returnFocus);
  return true;
}

// ─── the element ─────────────────────────────────────────────────────────────

/** The outcome element's attributes: its role, a programmatic focus stop (tabIndex -1),
 *  the key it answers for, and the Escape handler.
 * @param {any} outcome
 * @param {((el: any) => any) | null} [returnFocus]
 * @param {string} [extra]
 */
export function outcomeElementProps(outcome, returnFocus = null, extra = "") {
  return {
    class: `action-outcome action-outcome-${outcome.ok ? "applied" : "refused"}${extra ? ` ${extra}` : ""}`,
    role: outcomeRole(outcome),
    tabIndex: -1,
    "data-outcome-key": outcome.key,
    onKeyDown: (e) => outcomeKeyDown(e, returnFocus),
  };
}

/** The outcome element. `class` adds to `action-outcome action-outcome-<applied|refused>`. */
export function ActionOutcome({ outcome, returnFocus = null, class: extra = "", children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && shouldTakeFocus(outcome.id, typeof document === "undefined" ? null : document.activeElement, el)) el.focus();
  }, [outcome.id]);
  return h("div", { ref, ...outcomeElementProps(outcome, returnFocus, extra) }, children);
}

/** THE PLACEMENT: the control, then (when there is one) its outcome as the next sibling.
 *  `render(outcome)` supplies the outcome's content. */
export function placeOutcome(control, outcome, render, opts = {}) {
  if (!outcome) return [control];
  return [control, h(ActionOutcome, { key: `outcome-${outcome.id}`, outcome, returnFocus: opts.returnFocus ?? null, class: opts.class ?? "" }, render(outcome))];
}

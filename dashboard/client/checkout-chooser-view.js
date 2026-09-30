// FG-843: the checkout chooser in the screen header of Routing, Config and Notes — the
// only views whose answer changes with the checkout. checkout-label.js decides what it
// shows (checkoutChooser); this module only renders it.
//
// With two or more live operator checkouts it is a real button that opens a listbox:
// ArrowDown/ArrowUp/Home/End move between options, Enter or Space picks one, Escape (or
// Tab away, or a click outside) closes it and focus returns to the button. With fewer it
// is the checkout's label as plain text. Never rendered on any other view.

import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { RUN_CHECKOUT_LABEL, checkoutChooser } from "./checkout-label.js";

const html = htm.bind(h);

function Chips({ primary, run }) {
  return html`
    ${primary ? html`<span class="checkout-chooser-chip checkout-chooser-chip-primary">primary</span>` : null}
    ${run ? html`<span class="checkout-chooser-chip checkout-chooser-chip-run">${RUN_CHECKOUT_LABEL}</span>` : null}
  `;
}

export function CheckoutChooser({ project, selected, onChoose, idPrefix = "checkout-chooser" }) {
  const model = checkoutChooser(project, selected);
  // The menu is open FOR one project and checkout: a navigation that changes either closes
  // it in the same render, with no effect that could land after a fast reopen.
  const openKey = `${project?.key ?? ""}\n${model.current?.projectDir ?? ""}`;
  const [openFor, setOpenFor] = useState(null);
  const open = openFor === openKey;
  const setOpen = (next) => setOpenFor(next ? openKey : null);
  useEffect(() => {
    if (!open && openFor !== null) setOpenFor(null);
  }, [open, openFor]);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const options = [...(menuRef.current?.querySelectorAll("[role=option]") ?? [])];
    (options.find((o) => o.getAttribute("aria-selected") === "true") ?? options[0])?.focus();
    const onPointer = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  if (model.mode === "none") return null;
  const { current } = model;

  if (model.mode === "label") {
    return html`
      <div class="checkout-chooser" data-checkout-chooser="label">
        <span class="checkout-chooser-plain" title=${current.projectDir}>
          checkout: <span class="checkout-chooser-value">${current.label}</span>
          <${Chips} primary=${current.primary} run=${current.run} />
        </span>
      </div>
    `;
  }

  const close = (focusButton) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };
  const choose = (dir) => {
    close(true);
    if (dir !== current.projectDir) onChoose(dir);
  };
  const onMenuKeyDown = (e) => {
    const options = [...menuRef.current.querySelectorAll("[role=option]")];
    const at = options.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : options.length - 1;
      options[(Math.max(at, 0) + step) % options.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      options[e.key === "Home" ? 0 : options.length - 1]?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && at !== -1) {
      e.preventDefault();
      choose(options[at].dataset.checkout);
    }
  };
  const onButtonKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };
  const menuId = `${idPrefix}-menu`;
  return html`
    <div class="checkout-chooser" data-checkout-chooser="menu" ref=${rootRef}>
      <button
        type="button"
        class="checkout-chooser-button"
        ref=${buttonRef}
        aria-haspopup="listbox"
        aria-expanded=${open}
        aria-controls=${open ? menuId : undefined}
        aria-label=${`Checkout: ${current.label}${current.primary ? " (primary)" : ""}${current.run ? ` (${RUN_CHECKOUT_LABEL})` : ""}. Choose a checkout`}
        title=${current.projectDir}
        onClick=${() => setOpen(!open)}
        onKeyDown=${onButtonKeyDown}
      >
        checkout: <span class="checkout-chooser-value">${current.label}</span>
        <${Chips} primary=${current.primary} run=${current.run} />
        <span class="checkout-chooser-caret" aria-hidden="true">▾</span>
      </button>
      ${open ? html`
        <ul class="checkout-chooser-menu" id=${menuId} role="listbox" aria-label="Operator checkouts" ref=${menuRef} onKeyDown=${onMenuKeyDown}>
          ${model.options.map((option) => html`
            <li
              key=${option.projectDir}
              role="option"
              tabindex="-1"
              class="checkout-chooser-option"
              aria-selected=${option.selected ? "true" : "false"}
              data-checkout=${option.projectDir}
              title=${option.projectDir}
              onClick=${() => choose(option.projectDir)}
            >
              <span class="checkout-chooser-value">${option.label}</span>
              <${Chips} primary=${option.primary} run=${false} />
              <span class="checkout-chooser-path">${option.path}</span>
            </li>
          `)}
          <li role="presentation" class="checkout-chooser-footer">${model.footer}</li>
        </ul>
      ` : null}
    </div>
  `;
}

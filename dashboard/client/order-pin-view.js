// FG-819: the order-pinning hook the Home lists share. The decisions live in
// order-pin-render.js; this file owns only the timers and listeners that decide WHEN a
// boundary has passed.

import { h } from "preact";
import { useCallback, useEffect, useReducer, useRef } from "preact/hooks";
import htm from "htm";
import { ORDER_PIN_IDLE_MS, pinIdleElapsed, pinnedOrder } from "./order-pin-render.js";

const html = htm.bind(h);

/** Pin `items` (keyed by `keyOf`) to the order first shown until a boundary. Pass
 *  `items === null` while the list is not in a readable state: the pin is left alone, so
 *  a transient failed read does not count as a boundary. Returns the ordered items (null
 *  when given null), `resort` for a manual refresh, and `activityProps` to spread on the
 *  list's container so pointer/keyboard activity over it postpones the idle re-sort. */
export function usePinnedOrder(items, keyOf, idleMs = ORDER_PIN_IDLE_MS) {
  const pinned = useRef(null);
  const lastActivity = useRef(Date.now());
  const [, rerender] = useReducer((n) => n + 1, 0);

  const resort = useCallback(() => {
    pinned.current = null;
    lastActivity.current = Date.now();
    rerender();
  }, []);

  const markActive = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);

  useEffect(() => {
    let timer;
    const check = () => {
      const now = Date.now();
      if (pinIdleElapsed(lastActivity.current, now, idleMs)) {
        resort();
        timer = setTimeout(check, idleMs);
      } else {
        timer = setTimeout(check, idleMs - (now - lastActivity.current));
      }
    };
    timer = setTimeout(check, idleMs);
    return () => clearTimeout(timer);
  }, [idleMs, resort]);

  useEffect(() => {
    let wasHidden = document.visibilityState === "hidden";
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        wasHidden = true;
      } else if (wasHidden) {
        wasHidden = false;
        resort();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [resort]);

  let ordered = null;
  if (items !== null) {
    const next = pinnedOrder(pinned.current, items, keyOf);
    pinned.current = next.keys;
    ordered = next.items;
  }

  return {
    items: ordered,
    resort,
    activityProps: { onPointerMove: markActive, onPointerDown: markActive, onWheel: markActive, onKeyDown: markActive },
  };
}

/** The manual-refresh boundary: re-reads (when `onRefresh` is given) and re-sorts. */
export function PinRefreshButton({ label, onClick }) {
  return html`<button type="button" class="pin-refresh" aria-label=${label} onClick=${onClick}>Refresh</button>`;
}

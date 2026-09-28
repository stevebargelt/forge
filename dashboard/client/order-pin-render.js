// FG-819: order pinning for the 2-second Home lists (Attention inbox, In flight).
//
// The server re-ranks on every poll, so a row an operator is reading could jump out from
// under them. The client freezes the order it first showed and only adopts the server's
// ranking at a boundary: an idle stretch with no pointer/keyboard activity over the list,
// the tab coming back from hidden, or a manual Refresh. Between boundaries a new row is
// appended where it lands rather than reordering the rows already on screen, and a row
// the server dropped is dropped — pinning holds ORDER, never membership or content.

/** How long the list must go untouched before it re-sorts on its own. */
export const ORDER_PIN_IDLE_MS = 150_000;

/** Apply a pinned key order to the latest items. `pinnedKeys === null` means "adopt the
 *  server order" (mount before any rows, or a boundary just passed). Returns the ordered
 *  items and the key order to pin for the next render. */
export function pinnedOrder(pinnedKeys, items, keyOf) {
  if (pinnedKeys === null) {
    return { items, keys: items.map(keyOf) };
  }
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const pinned = new Set(pinnedKeys);
  const kept = pinnedKeys.filter((key) => byKey.has(key)).map((key) => byKey.get(key));
  const appended = items.filter((item) => !pinned.has(keyOf(item)));
  const ordered = [...kept, ...appended];
  return { items: ordered, keys: ordered.map(keyOf) };
}

/** Has the list been idle long enough to re-sort? */
export function pinIdleElapsed(lastActivityMs, nowMs, idleMs = ORDER_PIN_IDLE_MS) {
  return nowMs - lastActivityMs >= idleMs;
}

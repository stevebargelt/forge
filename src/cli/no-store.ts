// FG-608 red F9: FIRST RUN ON A FRESH HOST.
//
// getDb({readOnly: true}) REFUSES when ~/.forge/forge.db does not exist — creating
// a database as a side effect of reading it is never right (see db.ts). That
// refusal was correct and uncaught: every read-only survey command crashed on a
// host that had never run a workflow, and the alternative fix (drop the guard and
// let the query fall through to the writable handle) is worse — it recreates the
// exact bug the read-only path was added to kill, silently minting forge.db and
// running every migration from a `forge status`.
//
// So the boundary answers instead. A host with no store has no runs, no tasks, no
// metrics and no usage: the empty result is the TRUE answer, not an error, and
// these commands render it and exit 0 without touching the filesystem. Commands
// addressed to a SPECIFIC run still fail — "run X" cannot be answered by an empty
// store — but they fail with the reason rather than a store-layer refusal.

import { storeExists } from "../store/db.js";

/** Render the empty-store answer for a survey command. Returns true when it did,
 *  which is the caller's signal to return WITHOUT opening the store. */
export function renderedEmptyStore(json: boolean | undefined, emptyJson: unknown, humanLine: string): boolean {
  if (storeExists()) return false;
  if (json) console.log(JSON.stringify(emptyJson, null, 2));
  else console.log(humanLine);
  return true;
}

/** Throw the operator-facing "nothing to look up" error for a command addressed to
 *  a specific run/task on a host with no store. Named as a precondition failure,
 *  not as a store-layer surprise. */
export function assertStoreForLookup(what: string): void {
  if (storeExists()) return;
  throw new Error(
    `no forge store exists on this host yet, so there is no ${what} to read. Run a workflow ` +
      `(\`forge new …\`) or an import first — a read never creates the store.`,
  );
}

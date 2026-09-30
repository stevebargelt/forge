// FG-831: the ONE accessor for pruned_checkouts — checkout registrations the operator
// removed with `forge projects prune --missing`. The registry derives checkouts from
// runs, the filesystem scan and live sessions (src/util/projects.ts), so a prune is a
// recorded exclusion, not a delete: the runs that name the checkout stay, and nothing on
// disk is touched. Every write commits its checkout.pruned events row in the same
// transaction.

import { getDb, writeTransaction } from "./db.js";
import { logEvent } from "./events.js";
import { nowIso } from "../util/ids.js";

export function prunedCheckoutRoots(): Set<string> {
  const db = getDb();
  // A read-only handle on a store no writable open has migrated yet may lack the table;
  // nothing has been pruned there.
  const present = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pruned_checkouts'`).get();
  if (!present) return new Set();
  const rows = db.prepare(`SELECT checkout_root FROM pruned_checkouts`).all() as Array<{ checkout_root: string }>;
  return new Set(rows.map((row) => row.checkout_root));
}

/** Records each root as pruned (a root already recorded is left as it was). Returns the
 *  roots this call newly recorded. */
export function recordPrunedCheckouts(roots: string[], actor: string): string[] {
  return writeTransaction(() => {
    const insert = getDb().prepare(
      `INSERT OR IGNORE INTO pruned_checkouts (checkout_root, pruned_at, actor) VALUES (?, ?, ?)`,
    );
    const recorded: string[] = [];
    for (const root of roots) {
      if (insert.run(root, nowIso(), actor).changes === 0) continue;
      logEvent("checkout.pruned", { payload: { checkoutRoot: root, actor } });
      recorded.push(root);
    }
    return recorded;
  });
}

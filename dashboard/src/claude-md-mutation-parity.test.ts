// The workspace guide is what an agent reads before touching the server, so its account of
// what the dashboard may mutate must match the routes server.ts actually owns.
//
// server.ts listens on import, so its routing is read as source: every non-GET branch ahead
// of the 405 fallthrough must dispatch through a closed registry this test can resolve —
// QUEUE_MUTATION_ROUTES, ACTION_ROUTES (FG-822's task actions, FG-823's attention-row
// actions, FG-834's RACI actions, FG-835's model-policy actions and FG-845's attribution
// actions), or a named path constant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUEUE_MUTATION_ROUTES } from "./queue-mutation.js";
import { ACTION_ROUTES } from "./action-mutation.js";
import { SNOOZE_PRESETS } from "../client/attention-dismiss-render.js";
import { parseSnoozeUntil } from "../../src/store/attention-dismissals.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const guide = readFileSync(resolve(HERE, "..", "CLAUDE.md"), "utf8");
const serverSource = readFileSync(resolve(HERE, "server.ts"), "utf8");
const intro = guide.split("\n## ")[0]!;

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17 };

function exportedStringConst(name: string): string {
  const m = serverSource.match(new RegExp(`export const ${name} = "([^"]+)";`));
  assert.ok(m, `server.ts exports ${name} as a string literal`);
  return m[1]!;
}

/** Resolve every `if (req.method === "…" && <cond>)` branch ahead of the 405 fallthrough to
 *  the concrete paths it accepts. A branch shape this test cannot resolve fails outright, so
 *  a new mutating route cannot slip past the guide unnoticed. */
function serverMutatingRoutes(): { queue: string[]; actions: string[]; attention: string[]; raci: string[]; modelPolicy: string[]; attribution: string[]; all: string[] } {
  const fallthrough = serverSource.indexOf(`if (req.method !== "GET")`);
  assert.ok(fallthrough > 0, "server.ts refuses every non-GET it does not route");
  const branches = [...serverSource.slice(0, fallthrough).matchAll(/if \(req\.method === "([A-Z]+)" && ([^)]+\)?)\)\s*\{/g)];
  assert.ok(branches.length > 0, "server.ts routes at least one mutating method");
  const queue: string[] = [];
  const actions: string[] = [];
  const attention: string[] = [];
  const raci: string[] = [];
  const modelPolicy: string[] = [];
  const attribution: string[] = [];
  const all: string[] = [];
  for (const [, method, cond] of branches) {
    const c = cond!.trim();
    if (c === "isQueueMutationPath(path)") {
      const paths = Object.keys(QUEUE_MUTATION_ROUTES);
      queue.push(...paths);
      all.push(...paths.map((p) => `${method} ${p}`));
      continue;
    }
    if (c === "isActionMutationPath(path)") {
      const paths = Object.values(ACTION_ROUTES).map((row) => row.path);
      actions.push(...paths.filter((p) => p.startsWith("/api/task/")));
      attention.push(...paths.filter((p) => p.startsWith("/api/attention/")));
      raci.push(...paths.filter((p) => p.startsWith("/api/raci/")));
      modelPolicy.push(...paths.filter((p) => p.startsWith("/api/model-policy/")));
      attribution.push(...paths.filter((p) => p.startsWith("/api/ai-attribution/")));
      all.push(...paths.map((p) => `${method} ${p}`));
      continue;
    }
    const named = c.match(/^path === ([A-Z_]+)$/);
    assert.ok(named, `unrecognised mutating-route condition in server.ts: ${c}`);
    all.push(`${method} ${exportedStringConst(named[1]!)}`);
  }
  return { queue, actions, attention, raci, modelPolicy, attribution, all };
}

/** The routes the guide's "Mutations shell out" contract names for server.ts — stopping
 *  before the Remote Board, which is a separate listener. */
function guideMutatingRoutes(): string[] {
  const bullet = guide.split("\n").find((line) => line.startsWith("- **Mutations shell out.**"));
  assert.ok(bullet, "the guide carries the route contract bullet");
  const contract = bullet.split("Every other method is refused")[0]!;
  const routes: string[] = [];
  for (const [token] of contract.matchAll(/\/api\/[A-Za-z:/-]+(?:\|[a-z-]+)*/g)) {
    const base = token.slice(0, token.lastIndexOf("/") + 1);
    for (const leaf of token.slice(base.length).split("|")) routes.push(`POST ${base}${leaf}`);
  }
  return routes;
}

test("dashboard/CLAUDE.md intro names the closed mutation set, including the task, attention, RACI, model-policy and attribution actions", () => {
  const { queue, actions, attention, raci, modelPolicy, attribution } = serverMutatingRoutes();
  const m = intro.match(/the (\w+) `forge queue` verbs/);
  assert.ok(m, "the intro counts the forge queue verbs");
  assert.equal(NUMBER_WORDS[m[1]!], queue.length, "the intro's queue verb count matches server.ts");
  assert.match(intro, /`forge projects classify`/);
  const a = intro.match(/the (\w+) task actions/);
  assert.ok(a, "the intro counts the task actions");
  assert.equal(NUMBER_WORDS[a[1]!], actions.length, "the intro's task-action count matches ACTION_ROUTES");
  for (const verb of ["`forge gate`", "`forge retry`", "`forge recover --re-drive`"]) assert.ok(intro.includes(verb), `the intro names ${verb}`);
  const b = intro.match(/the (\w+) attention-row actions/);
  assert.ok(b, "the intro counts the attention-row actions");
  assert.equal(NUMBER_WORDS[b[1]!], attention.length, "the intro's attention-action count matches ACTION_ROUTES");
  assert.ok(intro.includes("`forge attention dismiss|snooze|undismiss`"), "the intro names the attention verbs");
  const r = intro.match(/the (\w+) RACI actions/);
  assert.ok(r, "the intro counts the RACI actions");
  assert.equal(NUMBER_WORDS[r[1]!], raci.length, "the intro's RACI-action count matches ACTION_ROUTES");
  assert.ok(intro.includes("`forge raci propose|apply`"), "the intro names the RACI verbs");
  const mp = intro.match(/the (\w+) model-policy actions/);
  assert.ok(mp, "the intro counts the model-policy actions");
  assert.equal(NUMBER_WORDS[mp[1]!], modelPolicy.length, "the intro's model-policy-action count matches ACTION_ROUTES");
  assert.ok(intro.includes("`forge model policy propose|apply`"), "the intro names the model-policy verbs");
  const at = intro.match(/the (\w+) attribution actions/);
  assert.ok(at, "the intro counts the attribution actions");
  assert.equal(NUMBER_WORDS[at[1]!], attribution.length, "the intro's attribution-action count matches ACTION_ROUTES");
  assert.ok(intro.includes("`forge config set|unset ai-attribution`"), "the intro names the attribution verbs");
  assert.match(intro, /Next, cancel and dispatcher arming stay CLI-only/);
});

test("dashboard/CLAUDE.md route contract lists every mutating route server.ts owns", () => {
  const { all } = serverMutatingRoutes();
  assert.deepEqual([...guideMutatingRoutes()].sort(), [...all].sort(), "the guide names exactly the mutating routes server.ts owns");
  const m = guide.match(/closed set of (\w+) mutating routes/);
  assert.ok(m, "the guide counts the mutating routes");
  assert.equal(NUMBER_WORDS[m[1]!], all.length, "the guide's route count matches server.ts");
  assert.match(guide, /There are no next, cancel or dispatcher routes/);
});

test("dashboard/CLAUDE.md snooze guidance names the inbox presets and the durations the route accepts", () => {
  const bullet = guide.split("\n").find((line) => line.startsWith("- **Server-side, audited, never in the browser.**"));
  assert.ok(bullet, "the guide carries the attention dismiss/snooze bullet");
  const presets = bullet.match(/snooze presets ((?:`[^`]+`,? ?)+)/);
  assert.ok(presets, "the bullet lists the inbox snooze presets");
  assert.deepEqual([...presets[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]), [...SNOOZE_PRESETS], "the guide's presets match the client's SNOOZE_PRESETS");
  const durations = bullet.match(/accept any duration — ((?:`[^`]+`,? ?)+)/);
  assert.ok(durations, "the bullet lists example durations the route and CLI accept");
  const named = [...durations[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  assert.ok(named.includes("2w"), "the guide names the two-week duration");
  for (const d of named) assert.equal(parseSnoozeUntil(d, Date.parse("2026-09-29T09:00:00Z")).ok, true, `parseSnoozeUntil accepts ${d}`);
});

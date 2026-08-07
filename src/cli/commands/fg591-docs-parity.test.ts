// FG-591 (step 17): the operator queue's DISPATCH surface — its verbs, its flags,
// its endpoints, its vocabularies and its stated capacity policy — is DOCUMENTED,
// and the documentation names only things that exist.
//
// ─── WHY THIS TEST HAS TO EXIST ──────────────────────────────────────────────
// fg609-docs-parity covers `forge backlog`'s four queue verbs. Nothing covers the
// twelve `forge queue` verbs, their flags, the two dashboard route families, or the
// capacity policy the AC requires to be stated in one place. So a verb could be
// renamed, a flag dropped or a route removed and the docs would keep describing the
// old surface with nothing noticing — which is worse than no docs, because a reader
// trusts them.
//
// ─── WHY IT IS NOT VACUOUS ───────────────────────────────────────────────────
// BOTH sides are derived. The command tree is built by calling the REAL
// `registerQueue` into a real Commander program and walking it, so a rename or a
// dropped option is visible here. The documented side is SCRAPED out of the prose —
// every `forge queue …` inline span and code-block line, every `/api/queue…` path,
// every backticked vocabulary list — and checked against the registered tree, the
// route table and the exported constants. So the test fails in both directions:
// a verb/flag/endpoint that ships undocumented, and a documented one that no longer
// exists. A hardcoded list of either side would survive a rename.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerQueue, BOARD_PROJECTIONS, DISPATCHER_STATUS_STATES } from "./queue.js";
import { RELEASE_OUTCOMES } from "../../queue/dispatch-execution.js";
import { DISPATCH_REASONS } from "../../store/dispatcher-evidence.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/** Where the queue/dispatcher surface is described to an operator. Each is a real
 *  entry point rather than a copy of another:
 *    concepts    — the MODEL (what the projections, the ceiling and the claim mean).
 *    quick-start — the PROCEDURE (§14, the commands in the order you run them).
 *    invariants  — the compressed rules that must hold.
 *    decision    — D1–D13, where this repo records decisions. */
const CONCEPTS = "docs/concepts.md";
const QUICK_START = "docs/quick-start.md";
const INVARIANTS = "docs/invariants.md";
const DECISION = "learnings/decisions/2026-08-06_queue-dispatch-capacity-and-authorization.md";

const DOC_SURFACES = [CONCEPTS, QUICK_START, INVARIANTS, DECISION];

// ─── the registered command tree, built from the real registrar ──────────────

type QueueTree = {
  /** Every verb under `forge queue`, dispatcher subverbs as "dispatcher <name>". */
  verbs: Set<string>;
  /** Verbs that are groups (they own subcommands), so a doc naming one alone is
   *  naming the group and a doc naming one with a word after it is naming a subverb. */
  groups: Set<string>;
  /** Long flags per verb, exactly as registered — including the ones a shared
   *  helper attaches, which a source scrape of `.option(` would miss. */
  flags: Map<string, Set<string>>;
};

function registeredQueueTree(): QueueTree {
  const program = new Command();
  registerQueue(program);
  const queue = program.commands.find((c) => c.name() === "queue");
  assert.ok(queue, "`forge queue` is not registered — every check below derives from it");

  const verbs = new Set<string>();
  const groups = new Set<string>();
  const flags = new Map<string, Set<string>>();

  const walk = (cmd: Command, prefix: string): void => {
    for (const sub of cmd.commands) {
      const name = prefix === "" ? sub.name() : `${prefix} ${sub.name()}`;
      verbs.add(name);
      if (sub.commands.length > 0) groups.add(name);
      flags.set(
        name,
        new Set(sub.options.map((o) => o.long).filter((l): l is string => typeof l === "string")),
      );
      walk(sub, name);
    }
  };
  walk(queue, "");
  return { verbs, groups, flags };
}

const tree = registeredQueueTree();
const allFlags = new Set<string>([...tree.flags.values()].flatMap((s) => [...s]));

// ─── the documented side, scraped from the prose ─────────────────────────────

type DocumentedCommand = { surface: string; raw: string; verb: string; flags: string[] };

/** Every `forge queue …` an operator could copy: inline code spans and code-block
 *  lines. A trailing `# comment` is stripped so prose in a comment is never read as
 *  argv. A span that is bare `forge queue` (the group, mid-sentence) matches nothing. */
function documentedCommands(surface: string): DocumentedCommand[] {
  const text = read(surface);
  const raws = [
    ...[...text.matchAll(/`(forge queue +[^`\n]*)`/g)].map((m) => m[1]!),
    ...[...text.matchAll(/^ *(forge queue +[^\n]*)$/gm)].map((m) => m[1]!),
  ];
  const out: DocumentedCommand[] = [];
  for (const raw of raws) {
    const tokens = raw.replace(/\s+#.*$/, "").trim().split(/\s+/).slice(2);
    const first = tokens[0];
    if (first === undefined || !/^[a-z][a-z-]*$/.test(first)) continue;
    const second = tokens[1];
    const isWord = second !== undefined && /^[a-z][a-z-]*$/.test(second);
    const verb = tree.groups.has(first) && isWord ? `${first} ${second}` : first;
    const flags = tokens.filter((t) => t.startsWith("--")).map((t) => t.replace(/[^a-z-].*$/, ""));
    out.push({ surface, raw, verb, flags });
  }
  return out;
}

const documented = DOC_SURFACES.flatMap(documentedCommands);

test("FG-591: the docs scrape actually found the queue surface (guards a silently-empty check)", () => {
  // Every assertion below iterates the scrape. An empty scrape would pass all of
  // them, which is the one way this test could go quietly vacuous.
  assert.ok(
    documented.length >= 12,
    `only ${documented.length} \`forge queue …\` command(s) were scraped out of the docs — ` +
      `either the surface is undocumented or the scrape stopped matching how it is written`,
  );
  assert.ok(tree.verbs.size >= 12, `only ${tree.verbs.size} verbs were registered: ${[...tree.verbs]}`);
});

test("FG-591: every DOCUMENTED `forge queue` verb exists in the registered command tree", () => {
  const bogus = documented.filter((d) => !tree.verbs.has(d.verb));
  assert.deepEqual(
    bogus.map((d) => `${d.surface}: \`${d.raw}\` → no such verb '${d.verb}'`),
    [],
    `the docs name a verb the CLI does not register. Registered: ${[...tree.verbs].sort().join(", ")}`,
  );
});

test("FG-591: every DOCUMENTED flag exists on the verb it is documented against", () => {
  const bogus: string[] = [];
  for (const d of documented) {
    const registered = tree.flags.get(d.verb) ?? new Set<string>();
    for (const flag of d.flags) {
      if (!registered.has(flag)) {
        bogus.push(
          `${d.surface}: \`${d.raw}\` → \`forge queue ${d.verb}\` has no ${flag} ` +
            `(it has: ${[...registered].sort().join(", ") || "no options"})`,
        );
      }
    }
  }
  assert.deepEqual(bogus, [], "a documented flag does not exist on that verb");
});

test("FG-591: every flag named in quick-start §14 exists somewhere on the queue tree", () => {
  // §14 discusses several flags away from a full command line ("--once / --max-ticks
  // are the rest of the knobs"). Those are still promises to a reader, so they are
  // still checked — against the union of the tree's options.
  const text = read(QUICK_START);
  const start = text.indexOf("## 14. The operator work queue");
  assert.ok(start > 0, "quick-start §14 is missing — the operator procedure lives there");
  const end = text.indexOf("\n## ", start + 1);
  const section = end === -1 ? text.slice(start) : text.slice(start, end);

  const mentioned = new Set(
    [...section.matchAll(/`(--[a-z][a-z-]*)[^`]*`/g)].map((m) => m[1]!),
  );
  const bogus = [...mentioned].filter((f) => !allFlags.has(f));
  assert.deepEqual(
    bogus,
    [],
    `quick-start §14 names flag(s) no \`forge queue\` verb registers. Registered: ${[...allFlags].sort().join(", ")}`,
  );
});

test("FG-591: every REGISTERED queue verb is documented on the model or the procedure surface", () => {
  const named = new Set(documented.map((d) => d.verb));
  const missing = [...tree.verbs].filter((v) => !named.has(v) && !tree.groups.has(v));
  assert.deepEqual(
    missing.sort(),
    [],
    "a queue verb shipped with no operator-facing text in docs/concepts.md or docs/quick-start.md",
  );
});

// ─── the dashboard route table ───────────────────────────────────────────────

/** Scraped from the dashboard source, deliberately: the mutation route table is a
 *  closed exported constant, and the read route is a literal path comparison. A
 *  renamed or removed route stops matching the documented one. */
function registeredRoutes(): Set<string> {
  const mutation = read("dashboard/src/queue-mutation.ts");
  const block = mutation.match(/QUEUE_MUTATION_ROUTES = \{([\s\S]*?)\n\}/);
  assert.ok(block, "dashboard/src/queue-mutation.ts no longer declares QUEUE_MUTATION_ROUTES");
  const routes = new Set([...block[1]!.matchAll(/"(\/api\/queue\/[a-z-]+)"/g)].map((m) => m[1]!));
  assert.ok(routes.size > 0, "the mutation route table scraped empty");

  const server = read("dashboard/src/server.ts");
  for (const m of server.matchAll(/path === "(\/api\/queue[a-z/-]*)"/g)) routes.add(m[1]!);
  return routes;
}

test("FG-591: every DOCUMENTED /api/queue endpoint exists in the dashboard route table", () => {
  const routes = registeredRoutes();
  assert.ok(routes.has("/api/queue"), "the board READ route is not served — the docs promise it");

  const bogus: string[] = [];
  let seen = 0;
  for (const surface of DOC_SURFACES) {
    for (const m of read(surface).matchAll(/(\/api\/queue[a-z/*-]*)/g)) {
      const path = m[1]!;
      seen += 1;
      // `POST /api/queue/*` is how the docs name the mutation FAMILY; it is satisfied
      // by the table carrying at least one route under that prefix.
      const ok = path.endsWith("/*")
        ? [...routes].some((r) => r.startsWith(path.slice(0, -1)))
        : routes.has(path);
      if (!ok) bogus.push(`${surface}: ${path}`);
    }
  }
  assert.ok(seen > 0, "no /api/queue endpoint is documented anywhere");
  assert.deepEqual(bogus, [], `documented endpoint(s) with no route. Served: ${[...routes].sort().join(", ")}`);
});

// ─── the vocabularies: documented lists are compared to the exported constants ──

/** The backticked `a | b | c` list following a marker phrase. Pulling the list out
 *  of the prose is what makes a renamed or added member fail here. */
function pipedListAfter(surface: string, marker: string): string[] {
  const text = read(surface);
  const at = text.indexOf(marker);
  assert.ok(at > 0, `${surface} no longer contains "${marker}"`);
  const m = text.slice(at).match(/`([a-z_]+(?: \| [a-z_]+)+)`/);
  assert.ok(m, `${surface}: no backticked vocabulary list follows "${marker}"`);
  return m[1]!.split(" | ");
}

test("FG-591: the documented evaluation-reason vocabulary is the exported one", () => {
  assert.deepEqual(
    pipedListAfter(CONCEPTS, "a top-level reason ("),
    [...DISPATCH_REASONS],
    "docs/concepts.md and DISPATCH_REASONS disagree about why a pass did or did not claim",
  );
});

test("FG-591: the documented release vocabulary is the exported one", () => {
  assert.deepEqual(
    pipedListAfter(DECISION, "FG-591 owns the release vocabulary this creates:"),
    [...RELEASE_OUTCOMES],
    "the decision record and RELEASE_OUTCOMES disagree about what a released reservation may say",
  );
});

test("FG-591: the five documented board columns are the five registered projections", () => {
  const concepts = read(CONCEPTS);
  for (const projection of BOARD_PROJECTIONS) {
    const label = projection.replace("_", " ");
    assert.match(
      concepts,
      new RegExp(`\\*\\*${label}\\*\\*`, "i"),
      `docs/concepts.md never names the '${projection}' board column`,
    );
  }
  // The sixth state exists on purpose (D4) and is the one a reader would otherwise
  // assume is a bug, so it is named literally rather than described.
  assert.match(concepts, /`executing_not_queued`/);
});

test("FG-591: every no-run state quick-start tells an operator to expect is a real one", () => {
  const text = read(QUICK_START);
  const at = text.indexOf("It keeps the answers apart instead of collapsing them");
  assert.ok(at > 0, "quick-start no longer explains `forge queue dispatcher status`");
  const paragraph = text.slice(at, text.indexOf("\n\n", at));
  const named = [...paragraph.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
  assert.ok(named.length >= 6, `only ${named.length} status state(s) named; the AC requires six distinguishable`);
  const bogus = named.filter((s) => !DISPATCHER_STATUS_STATES.includes(s as never));
  assert.deepEqual(
    bogus,
    [],
    `quick-start names status state(s) the CLI cannot emit. Real: ${DISPATCHER_STATUS_STATES.join(", ")}`,
  );
});

// ─── the capacity policy the AC requires to be stated ────────────────────────

test("FG-591 AC9: the capacity policy states, in ONE place, what is counted, what is only reported, and why", () => {
  const text = read(CONCEPTS);
  const at = text.indexOf("**The capacity policy, stated.**");
  assert.ok(at > 0, "docs/concepts.md has no stated capacity policy — AC9 requires an explicit one");
  const paragraphs = text.slice(at).split("\n\n");
  // The policy is one statement across the ceiling paragraph and the accounting
  // paragraph that follows it; both are required, so both are read as one place.
  const policy = paragraphs.slice(0, 2).join("\n\n");
  assert.ok(paragraphs.length >= 2, "the capacity policy is truncated");

  const claims: [string, RegExp][] = [
    ["what the ceiling bounds", /hard bound on \*\*queue-owned/],
    ["where it is counted", /inside `claimNextEligible`'s write transaction/],
    ["why nowhere else works", /advisory|over-admits/],
    ["which scope", /host-scoped/],
    ["what is not counted", /operator-initiated runs.*campaign items.*review loops/s],
    ["that it is reported instead", /REPORTED beside the ceiling and never counted against it/],
    ["why a subtraction is refused", /reads as a guarantee while being a guess/],
  ];
  for (const [label, pattern] of claims) {
    assert.match(policy, pattern, `the capacity policy does not state ${label}`);
  }
});

test("FG-591 AC9: the operator-facing surfaces do not contradict the capacity policy", () => {
  // A second surface may summarise it; it may not say something else. Both of these
  // must keep the two halves — a bound on queue-owned work, and other work reported
  // rather than subtracted.
  assert.match(read(QUICK_START), /never subtracted from it/);
  assert.match(read(INVARIANTS), /REPORTED beside the ceiling and never subtracted from it/);
});

// ─── the recorded decisions ──────────────────────────────────────────────────

test("FG-591: D1–D13 are recorded where this repo records decisions, and the docs link to it", () => {
  assert.ok(existsSync(join(repoRoot, DECISION)), `${DECISION} is missing — D1–D13 are not recorded`);
  const record = read(DECISION);
  assert.match(record, /\*\*ID\*\*: FORGE-DEC-033/);
  for (let n = 1; n <= 13; n += 1) {
    assert.match(record, new RegExp(`### D${n} — `), `the decision record has no D${n}`);
  }
  // The two FG-610 deliberately deferred, which is why this record exists at all.
  assert.match(record, /### D3 — the capacity ceiling is HOST-scoped/);
  assert.match(record, /### D4 — dequeue never releases a live claim/);

  for (const surface of [CONCEPTS, INVARIANTS]) {
    const text = read(surface);
    const link = text.match(/[\w./-]*2026-08-06_queue-dispatch-capacity-and-authorization\.md/);
    assert.ok(link, `${surface} does not point at the decision record`);
    // Both spellings are in use in this repo: a relative markdown link from the doc's
    // own directory (concepts.md) and a repo-root-relative path in backticks
    // (invariants.md, matching invariant 20's existing citations). Either must resolve.
    const targets = [resolve(dirname(join(repoRoot, surface)), link[0]), join(repoRoot, link[0])];
    assert.ok(
      targets.some((t) => existsSync(t)),
      `${surface} cites ${link[0]}, which resolves to no file`,
    );
  }
});

test("FG-591: the non-negotiables are stated, not implied", () => {
  // Each of these is a rule a reader has to be able to find. They are the ones whose
  // absence from the docs would let the next change quietly reintroduce the defect.
  const claims: [string, string, RegExp][] = [
    ["concepts", CONCEPTS, /continuously evaluated scheduling policy, not a campaign/i],
    ["concepts", CONCEPTS, /projections over orthogonal durable fields, not five competing statuses/i],
    ["concepts", CONCEPTS, /never labelled Blocked/],
    ["concepts", CONCEPTS, /Dequeue is not cancel/],
    ["concepts", CONCEPTS, /admission tests, never reapers/i],
    ["concepts", CONCEPTS, /planning intent/],
    ["invariants", INVARIANTS, /Queue membership is planning intent/],
    ["invariants", INVARIANTS, /never releases a live claim/],
    ["quick-start", QUICK_START, /Queueing is planning intent/],
    ["quick-start", QUICK_START, /never kill work/i],
  ];
  for (const [label, file, pattern] of claims) {
    assert.match(read(file), pattern, `${label} (${file}) is missing: ${pattern}`);
  }
});

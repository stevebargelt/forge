// FG-608: THE IN-CONTAINER `forge backlog` READER. This file is the entire forge
// surface an agent container has, and it is deliberately tiny.
//
// ─── WHY IT EXISTS AS ITS OWN FILE ───────────────────────────────────────────
// The container read path used to be reachable only by bind-mounting the host's
// forge checkout at /forge-src and running `tsx src/cli/index.ts` — something only
// a test ever did. Production mounted the project and the snapshot directory and
// nothing else, so the shipped claim ("run `forge backlog show` in your container")
// was false everywhere except in that test. This file is what makes it true: the
// agent image COPYs it, and spawn.ts ALSO binds the dispatching forge's copy over
// the same path, so a stale image cannot answer ticket questions with an old reader.
//
// ─── NO DEPENDENCIES, BY CONSTRUCTION ────────────────────────────────────────
// node:sqlite, not better-sqlite3: a native module has to be built for the image's
// platform and is exactly the kind of thing that breaks across this mount layer
// (FORGE-DEC-011). node:sqlite ships with Node itself, so a bind-mounted .mjs is a
// complete, working reader with nothing to install.
//
// ─── THE REFUSAL RULES ARE THE SAME ONES src/backlog/container-authority.ts USES ──
// and for the same measured reason: FORGE_HOME is unset in a container, so any
// fallback to $HOME/.forge lands on the SHARED forge-claude-oauth named volume,
// which carries a full ticket schema belonging to no project. Answering from there
// looks like success and is wrong. So:
//
//   * the AUTHORITY MARKER at the compiled-in mount path decides whether this is a
//     dispatched container. Not an environment variable — the agent owns its own
//     environment and would otherwise be able to switch the gate off;
//   * a marker saying `db` with no readable snapshot REFUSES. It never falls back;
//   * a snapshot published for a different project_key than the marker names
//     REFUSES — "it opened" is not "it is this task's authority";
//   * every mutating verb REFUSES with a non-zero exit. (The enforcement half is
//     the `:ro` bind, since agents have passwordless root; this is the polite half.)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MOUNT = "/forge-backlog";
const MARKER_BASENAME = "authority.json";
const DB_BASENAME = "backlog.db";
const SNAPSHOT_DIR_ENV = "FORGE_BACKLOG_SNAPSHOT_DIR";
const DISPATCHED_TICKET_ENV = "FORGE_DISPATCHED_TICKET";

const EXIT_REFUSED = 3;

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_REFUSED);
}

/** The dispatched authority. The compiled-in mount path wins and, when its marker
 *  is present, the environment is not consulted at all. */
function authority() {
  const fixed = join(MOUNT, MARKER_BASENAME);
  if (existsSync(fixed)) return { dir: MOUNT, marker: parseMarker(fixed) };
  const envDir = (process.env[SNAPSHOT_DIR_ENV] ?? "").trim();
  if (!envDir) return null;
  const marked = join(envDir, MARKER_BASENAME);
  if (existsSync(marked)) return { dir: envDir, marker: parseMarker(marked) };
  return { dir: envDir, marker: { mode: "db", projectKey: null, taskId: null } };
}

function parseMarker(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    refuse(
      `forge: refusing to read the backlog — the container authority marker at ${path} is not ` +
        `readable JSON. A broken dispatch is not a licence to answer from somewhere else.`,
    );
  }
  if (parsed.kind !== "forge-backlog-authority") {
    refuse(`forge: refusing to read the backlog — ${path} is not a forge authority marker.`);
  }
  return { mode: parsed.mode, projectKey: parsed.projectKey ?? null, taskId: parsed.taskId ?? null };
}

function openSnapshot() {
  const resolved = authority();
  if (!resolved) {
    refuse(
      `forge: refusing to read the backlog — no ticket authority was mounted for this task. forge ` +
        `does NOT fall back to $HOME/.forge here: inside an agent container that path is a shared ` +
        `named volume belonging to no project, and reading it would silently answer from another ` +
        `project's store. Ask the operator to re-dispatch this task with a backlog snapshot mount.`,
    );
  }
  if (resolved.marker.mode === "markdown") {
    refuse(
      `forge: this project has not cut over to the DB backlog, so no snapshot was published for ` +
        `this task. Its tickets are the Markdown files in the mounted checkout — read ` +
        `/project/backlog directly.`,
    );
  }
  if (resolved.marker.mode !== "db") {
    refuse(
      `forge: refusing to read the backlog — this task's authority marker says ` +
        `'${resolved.marker.mode}': the host could not resolve or publish a ticket authority for it. ` +
        `Report what you needed in your result rather than reading an unrelated store.`,
    );
  }
  const path = join(resolved.dir, DB_BASENAME);
  if (!existsSync(path)) {
    refuse(
      `forge: refusing to read the backlog — the mounted authority at ${path} does not exist. The ` +
        `host publishes this file; its absence means no snapshot was ever published for this task, ` +
        `not that the project has no tickets.`,
    );
  }
  const db = new DatabaseSync(path, { readOnly: true });
  const meta = db.prepare(`SELECT project_key, published_at, max_revision FROM snapshot_meta LIMIT 1`).get();
  if (!meta) {
    refuse(`forge: the mounted authority at ${path} carries no snapshot_meta row — it is not a forge snapshot.`);
  }
  if (resolved.marker.projectKey && meta.project_key !== resolved.marker.projectKey) {
    refuse(
      `forge: refusing to read the backlog — the mounted snapshot at ${path} was published for ` +
        `project_key '${meta.project_key}', but this task was dispatched against ` +
        `'${resolved.marker.projectKey}'.`,
    );
  }
  return { db, meta };
}

function banner(meta) {
  process.stderr.write(
    `store: db snapshot (project_key=${meta.project_key}, published ${meta.published_at}, read-only mount)\n`,
  );
}

function hydrate(db, row) {
  const related = db
    .prepare(`SELECT related_id FROM ticket_relations WHERE ticket_id = ? AND rel_type = 'related' ORDER BY related_id`)
    .all(row.ticket_id)
    .map((r) => r.related_id);
  // 'blocked' is not a stored status — it is active + durable blocker evidence.
  const blocked =
    row.status === "active" &&
    db.prepare(`SELECT 1 FROM blocker_evidence WHERE ticket_id = ? LIMIT 1`).get(row.ticket_id) !== undefined;
  return {
    id: row.ticket_id,
    type: row.type,
    status: blocked ? "blocked" : row.status,
    ...(related.length > 0 ? { related } : {}),
    ...(row.created ? { created: row.created } : {}),
    ...(row.closed ? { closed: row.closed } : {}),
    ...(row.closed_commit ? { closedCommit: row.closed_commit } : {}),
    ...(row.epic ? { epic: row.epic } : {}),
    title: row.title,
    body: row.body,
    revision: row.revision,
    bodyHash: row.body_hash,
  };
}

const SELECT_COLUMNS = `ticket_id, type, status, title, body, created, closed, closed_commit, epic, revision, body_hash`;

/** The dispatched-vs-current line. NO SILENT RECONCILIATION IN EITHER DIRECTION —
 *  both numbers are simply stated. */
function revisionDrift(live) {
  const raw = (process.env[DISPATCHED_TICKET_ENV] ?? "").trim();
  if (!raw) return null;
  const [ticketId, revision, bodyHash] = raw.split(":");
  if (!ticketId || !revision || !bodyHash) return null;
  if (ticketId !== live.id) return null;
  const dispatched = Number.parseInt(revision, 10);
  if (dispatched === live.revision && bodyHash === live.bodyHash) return null;
  return (
    `note: this ticket has ADVANCED since the task was dispatched — dispatched revision ` +
    `${dispatched} (body ${bodyHash.slice(0, 12)}), current revision ${live.revision} ` +
    `(body ${(live.bodyHash ?? "unknown").slice(0, 12)}). The task package you were given describes ` +
    `the dispatched revision; the text above is current authority.`
  );
}

const MUTATION_VERBS = new Set([
  "file", "close", "edit", "retitle", "move", "import", "mode", "migrate", "reidentify", "forget-source",
]);

function refuseMutation(verb) {
  // Mode-specific: a markdown-mode container has no snapshot to be read-only ABOUT
  // — what it must not reach is the host store.
  const snapshot = authority()?.marker.mode === "db";
  refuse(
    `forge: refusing \`backlog ${verb}\` — ` +
      (snapshot
        ? `this task's backlog authority is a READ-ONLY mounted snapshot. `
        : `this command writes the host store, which no agent container may reach. `) +
      `Ticket mutations happen on the host, against the authoritative store; there is no write path ` +
      `from an agent container, and a local write would be invisible to everyone. Report the change ` +
      `you want in your result instead.`,
  );
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  if (argv[0] !== "backlog") {
    refuse(
      `forge: this container ships the backlog READER only (\`forge backlog list|show\`). Every other ` +
        `forge command runs on the host, against the authoritative store.`,
    );
  }
  const verb = argv[1];
  if (MUTATION_VERBS.has(verb)) refuseMutation(verb);

  const rest = argv.slice(2);
  const json = rest.includes("--json");

  if (verb === "list") {
    const { db, meta } = openSnapshot();
    banner(meta);
    const type = flag(rest, "type");
    const status = flag(rest, "status");
    const search = flag(rest, "search")?.toLowerCase();
    const tickets = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM tickets ORDER BY ticket_id ASC`)
      .all()
      .map((r) => hydrate(db, r))
      .filter((t) => {
        if (type && t.type !== type) return false;
        if (status && t.status !== status) return false;
        if (search && !`${t.title} ${t.body}`.toLowerCase().includes(search)) return false;
        return true;
      });
    if (json) {
      console.log(JSON.stringify(
        tickets.map((t) => ({ id: t.id, type: t.type, status: t.status, title: t.title, revision: t.revision })),
        null, 2,
      ));
    } else if (tickets.length === 0) {
      console.log("(no matching tickets)");
    } else {
      for (const t of tickets) console.log(`  ${t.id}  [${t.type}/${t.status}]  ${t.title}`);
    }
    db.close();
    return;
  }

  if (verb === "show") {
    const id = rest.find((a) => !a.startsWith("--"));
    if (!id) refuse("forge: `backlog show` needs a ticket id (e.g. forge backlog show FG-123).");
    const { db, meta } = openSnapshot();
    banner(meta);
    const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM tickets WHERE ticket_id = ?`).get(id);
    if (!row) {
      process.stderr.write(`forge: Ticket ${id} not found\n`);
      process.exit(1);
    }
    const live = hydrate(db, row);
    const drift = revisionDrift(live);
    if (json) {
      console.log(JSON.stringify({ ...live, revisionDrift: drift }, null, 2));
    } else {
      console.log(`### ${live.id} — ${live.title}`);
      console.log(`(${live.type}/${live.status}, revision ${live.revision})`);
      console.log("");
      console.log(live.body.trimEnd());
      if (drift) process.stderr.write(drift + "\n");
    }
    db.close();
    return;
  }

  refuse(
    `forge: unknown or unavailable verb \`backlog ${verb ?? ""}\`. This container ships the READER ` +
      `only: \`forge backlog list\` and \`forge backlog show <id>\`.`,
  );
}

main(process.argv.slice(2));

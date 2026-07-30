# Decision: Agent containers read tickets from a host-published, project-scoped snapshot on a read-only directory mount

**ID**: FORGE-DEC-029
**Date**: 2026-07-29
**Status**: Decided
**Decided by**: forge
**Supersedes**: N/A
**Scope**: Workspace
**Elevated from**: N/A

---

## Context

FG-607 made a project's ticket store selectable (`markdown` files vs `db` rows keyed by `project_key`), and FG-608 made `db` actually authoritative per project via `forge backlog migrate`. That exposed a blocker: **agent containers could not see db-mode tickets at all.** An agent gets `/project` mounted (read-only for reds) and no ticket database, so after a cutover it would either lose the ticket entirely or read the checkout's frozen `backlog/*.md` — stale by construction, since nothing writes those files again.

Two constraints shaped the answer before any option was on the table:

- **Agents have root in their own container.** The image creates `agent` with `NOPASSWD:ALL` and no `--user` is passed, so a CLI-level refusal is not an enforcement primitive — `sudo` undoes it. Only the kernel-enforced `:ro` bind survives.
- **`FORGE_HOME` is unset inside a container**, so the ordinary store-path resolution lands on `/home/agent/.forge/forge.db` — and `/home/agent` is the `forge-claude-oauth` **named volume**, mounted read-write and shared by every claude-oauth container on the host regardless of project. It already carries a full ticket schema. Any "fall back to the default store" path therefore *succeeds*, against a store belonging to no project, and leaks between containers.

---

## Problem

How does a running agent container obtain its project's authoritative tickets — including an amendment an operator makes *after* the container started — without exposing other projects' tickets or forge's control plane, and without any write path back to the host store?

---

## Options Considered

### Option A: Dispatch-time injection only

Serialize the ticket into the task package at dispatch and let the agent read that.

**Pros**:
- Zero new mounts, zero new artifacts, already how the task brief works.

**Cons**:
- **Cannot satisfy post-start amendment visibility at all.** An operator who fixes a ticket while the agent is working has no way to reach it, which is the case that motivated the ticket.
- Silently ages: the longer the task, the more wrong the package.

---

### Option B: Mount the host `~/.forge/forge.db` read-only

**Pros**:
- Trivially live; no new artifact to build or keep fresh.

**Cons**:
- Read-only is not confidentiality. Every other project's tickets, plus runs, tasks, events, gates and verdicts, become readable by any agent.
- Isolation would rest on a `WHERE project_key = ?` the agent can simply not write.
- A WAL database cannot be opened from a non-writable directory at all (`SQLITE_READONLY_DIRECTORY` — SQLite must create the `-shm`/`-wal` sidecars), and forge's store is WAL.

---

### Option C: A host-side query service the container calls ✅

**Pros**:
- Live by definition; the host can enforce scope per request.

**Cons**:
- A new long-lived host service, a new protocol, and a new authentication problem — the container must prove which project it is, which is exactly the thing a container cannot do honestly (see Implementation Notes).
- Far more machinery than a read path needs.

---

### Option D: Host publishes a per-project, backlog-only snapshot into a read-only directory mount ✅

The host builds a small non-WAL SQLite file containing only one `project_key`'s tickets, relations and blocker evidence, and republishes it on every authoritative ticket write to every live container registered for that project.

**Pros**:
- **Project isolation is structural**: the other projects' rows and the control-plane tables are not in the file. There is nothing to filter and nothing to un-filter.
- **Live**: republication on the host write path makes a post-start amendment visible to the container's next read.
- **Read-only is kernel-enforced** by the `:ro` bind, which root inside the container cannot undo.
- No service, no protocol, no network surface.

**Cons**:
- The snapshot is a derived artifact that can go stale if publication fails — a state that must be surfaced rather than hidden.
- Fan-out cost on the host write path, proportional to live containers for that project.

---

## Decision

**Chose**: Option D — host-published snapshot on a read-only directory mount.

**Rationale**: It is the only option that gets post-start amendment visibility (which A cannot) while making project isolation a property of the artifact rather than of a query (which B cannot), and it does so without standing up a service and an in-container identity story (which C requires). The two hard constraints — root inside the container, and a shared oauth volume sitting exactly where a default store lookup lands — mean the boundary has to be something the kernel enforces and something the agent cannot forge. A `:ro` bind of a directory the host publishes into — by rename, including after the container has started — is both.

---

## Consequences

**Positive**:
- `forge backlog list` / `show` work inside a container against real, current authority, and refuse rather than answer from the wrong store.
- Mutating verbs have one honest answer everywhere: ticket changes happen on the host.
- The dispatched ticket revision stays recorded for reproducibility while the live surface reports the current one, so drift is *stated* rather than reconciled in either direction.

**Negative / Trade-offs**:
- A second, derived copy of ticket data exists per running container, with its own freshness question.
- Every authoritative host ticket write now carries a publication tail.

**Risks**:
- **Silent staleness** would be the worst failure: a container reading an old ticket while everything looks fine. Mitigated by bounding publication retries, marking an exhausted target STALE durably, and warning about stale targets in host `forge backlog` output.
- Snapshot directories accumulate per task. Dispatch releases the targets of tasks it can *prove* are finished; an unresolvable task is "unknown", which releases nothing and deletes nothing, because that directory may be a live container's mount source.

---

## Implementation Notes

- **A DIRECTORY is mounted, not the file, and that is a requirement.** A file bind pins the inode at container start; publication is write-temp + rename, which allocates a new one, so a file mount would freeze the container's view for its whole life (forge containers are one-per-task, long-lived, never restarted). Renaming *inside* a mounted directory gives both atomicity and visibility. The in-container reader also re-opens on every call for the same reason.
- **The published artifact must be non-WAL.** A WAL database cannot be opened read-only from a non-writable directory.
- **Authority is asserted by the mount, never derived in-container.** Container git evidence is deterministically wrong *and collides*: `/project`'s origin is a bare local path, so identity falls to the git-common-dir rung and yields `/project/.git` — identical in every container for every project. So the host writes an unforgeable marker into the mount source before the container starts, and the reader gates on that marker at a compiled-in path. An environment variable would be a gate owned by the party being gated: an agent can `unset` it or repoint it.
- **Testing the rules inside a container needs an OPT-IN seam, not a relaxation.** A compiled-in probe means a suite that spawns a `forge` CLI child inside an agent container asserts against *that* container's marker rather than its own fixture — silently, and with exit 0 on reads. The TypeScript resolver therefore carries `setAuthorityMountForTest`, delivered to a spawned child through an explicit `--import` preload (FG-645; see `docs/how-to-testing.md` → "Spawning a `forge` CLI child"). It does not weaken the rule above: nothing reads the seam's variable unless the process was told to load the preload, so the gate is still not one an agent can open from outside. The shipped reader (`docker/forge-backlog-reader.mjs`) gets no such seam — it is the container's only forge surface, so an override there would be reachable by the party being gated; its suite patches the mount line in a copy instead.
- **Never fall back.** No marker, a marker whose authority has no snapshot, or a snapshot published for a different `project_key` all REFUSE. The reason is the shared oauth volume described in Context — a fallback there looks like success.
- **The reader ships in the image and is bound over at dispatch.** Claiming an in-container `forge backlog` surface while the image shipped no forge CLI made the whole read path a test fiction. The image now `COPY`s `docker/forge-backlog-reader.mjs` and `docker/forge-backlog-bin.sh`; forge also binds its own copies over the same paths, so a container runs the dispatching forge's reader rather than whatever the image baked in. The reader uses `node:sqlite`, never `better-sqlite3` — a native binding must be built for the image's platform and is exactly what breaks across this mount layer (FORGE-DEC-011).
- **Publication is owned in one place** (`src/backlog/snapshot.ts`), invoked from one choke point on the host write path, and runs *after* the durable commit — never inside the transaction, which would do external I/O under the write lock and could publish rows that then roll back. A publication failure never fails or rolls back the authoritative write: the DB is truth, the snapshot is derived.
- Testing this needs **two separately-proven properties**: atomic replacement (no torn reads) and end-to-end delivery (a host write reaching an already-running container through the production fan-out). A test of the first is not evidence of the second.

---

## Revisit Conditions

- If agents ever need to *write* tickets, this decision does not stretch — a write path is a different design (host-mediated proposals), not a relaxation of the `:ro` mount.
- If per-write fan-out cost becomes visible on interactive CLI writes with many live containers for one project, revisit the publication trigger (coalescing, or a pull-with-notify shape).
- If a container ever gains a trustworthy identity primitive, Option C becomes cheaper than it is today.

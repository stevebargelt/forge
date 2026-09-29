# Someday

Ideas Forge may want later. This is not the backlog and not a plan. Nothing here
is scheduled, sized, or promised, and nothing here should be filed as a ticket
until a real project needs it. The point is to keep the idea, its evidence, and
the trigger that would make it current, without clogging `forge backlog`.

How an item moves:

- **In:** a capability we deliberately declined or deferred, with a note of why
  and what would change the answer.
- **Out (promoted):** a concrete project needs it. File the ticket, link it
  here for one release, then remove the entry.
- **Out (dropped):** the trigger stopped being plausible. Delete the entry; git
  history keeps it.

Keep entries short. Evidence lives in `docs/research/`; link to it rather than
restating it.

---

## Connectors: governed connections to external services

**What.** A way for a Forge project to act on an external system through a
governed connection: a stored credential, a scoped grant to a role, and audit.
Example: a project that reads a mailbox and files or triages work from it would
need a Gmail connector; a project that publishes to a CMS would need that CMS's
connector. Paperclip's Apps catalog is the reference implementation
(`docs/research/competitive/paperclip-forge-assessment.md`, lane B section 6 and
the connector playbook at `doc/connections/CONNECTOR-PLAYBOOK.md` in the
Paperclip repo).

**Why someday, not now.** Forge's outbound integrations today (git, `gh`, ntfy,
Twilio, the external kanban projection) all live on the host under the
operator's identity. Container agents reach nothing external by design. No
current project needs an agent to call a third-party service.

**What we would borrow when the time comes.**

- A connector is data, not code: branding, fields, validation, scoped defaults.
  The generic route (any remote MCP server, or any env-injected credential)
  and a curated entry converge on the same pipeline.
- Identity and resource credentials never mix. The Claude OAuth volume and the
  remote board's transport identity are sign-in identities and are never reused
  as connector credentials.
- Connection intents: an agent asks for a service mid-run as a typed ask
  (recommendation 9 in `paperclip-forge-recommendations.md`); the operator
  binds the credential to the requesting role (recommendation 16, role-scoped
  secret bindings); the task re-dispatches. Grants are scoped to the requesting
  role, never company-wide.
- Per-run, short-lived tokens revoked at run end; per-call audit tied to the
  task.

**What we would not borrow.** A thirty-vendor catalog with per-vendor OAuth
flows, icons, and verification docs; a hosted identity service; dependence on a
third-party aggregator (Paperclip retired its Composio broker).

**Trigger.** The first project whose brief requires an agent, not the operator,
to read from or write to an external service with a credential. Prerequisites
already in the recommendations doc: typed operator asks (9) and role-scoped
secret bindings (16).

## Non-code deliverables: work products that live outside a repo

**What.** Forge tasks whose output is not a commit: a rendered video, a PDF
report, a slide deck, a dataset, a generated site. Today every Forge
deliverable is a commit, a PR, a doc in the repo, or a review-ledger row, and
git is the artifact store. A project that "produces a video" or "creates a
report" has nowhere durable to put the result and no object that names it.

**Why someday, not now.** No current project produces a non-repo deliverable.
Logs, raw results and test output are diagnostics, not artifacts, and belong
where they are. Screenshots and the per-task "what did this produce" link are
covered by the cockpit recommendation in
`docs/research/competitive/paperclip-forge-recommendations.md` without a new
store.

**What we would borrow when the time comes.** Paperclip's work-product model
(`packages/db/src/schema/issue_work_products.ts` in the Paperclip repo;
`doc/AGENT-ARTIFACTS.md`):

- A typed work-product row per deliverable: kind, title, sha256, byte size,
  `created_by_task`, `is_primary` (this is *the* deliverable), and a
  provenance field. Written by the host at task finalize from a receipt, never
  by the agent editing the store.
- The `register_deliverable` receipt shape: the agent supplies a
  workspace-relative path, content type, exact size and hash, and an
  idempotency key; the host verifies the bytes, stores them, and returns the
  receipt. A path claimed in `result.json` that does not exist is a validation
  failure.
- The rule "a local workspace path is not enough": a deliverable must be
  registered before the task can report complete, and the final result must
  link it. Workspace files that intentionally stay in a checkout are
  signposts, not deliverables.
- A per-task Artifacts tab that opens on arrival, and a project-wide index
  filterable by kind.
- Storage under `~/.forge/artifacts/<project_key>/` first; an object store
  later if artifacts need to leave the host.

**What we would not borrow.** Agent-initiated uploads through a control-plane
API (containers never reach the host store, invariant 20), the document
annotation and revision system, and `healthStatus` for deployed previews.

**Trigger.** The first project whose brief names a deliverable that is not a
commit. Prerequisites: typed operator asks (recommendation 9) if the agent
needs to ask where a deliverable goes, and the cockpit's task-to-deliverable
link so the new object has a place to appear.

## Governed tool gateway (MCP)

**What.** A proxy between agents and third-party tool servers with profiles,
policies, quarantine of changed tool definitions, approval gates on specific
calls, and per-call audit. Paperclip's version is described in lane B section 6.

**Why someday.** Containers get no MCP servers today, and recommendation 5 in
the recommendations doc closes the door on a repo-supplied one. There is nothing
to govern until connectors exist.

**Trigger.** Connectors (above) plus more than one role allowed to call the
same external tool with different permissions. If it ever lands: deny must beat
allow structurally and be tested, because Paperclip's first-match semantics
drifted from its own documentation.

## Second human approver

**What.** A second person who can approve gates, answer asks, or apply routing
changes, with the responsible-human intersection Paperclip uses (an agent's
request must pass as the agent and as its responsible human).

**Why someday.** Forge is single-operator by design (`src/v2/host-readiness.ts`,
invariant 15). Every human-authority surface assumes one accountable person.

**Trigger.** A second person shares a Forge host or a remote board with write
intent. Study Paperclip's memberships and permission-grant model then, not
before.

## Answering from chat channels

**What.** Slack, Discord, or Telegram threads that render an operator ask as
native buttons and accept the answer back. Paperclip's chat-connector subsystem
is the reference and is, by its own qualification docs, not production-ready on
any provider.

**Why someday.** Recommendation 18 (answer asks from a phone) covers the
single-operator case through the remote board with opaque tokens. A chat
channel adds identity linking, delivery leases, and a large surface for a
second way to do the same thing.

**Trigger.** A team, not a person, needs to answer asks, or ntfy plus the
remote board proves insufficient in practice.

## Per-role budgets (usage ceilings)

Paperclip's Budgets page sets hard-stop spend limits per agent and per project, with incidents, override approvals, and paused agents. Forge has no per-role ceiling: usage is tokens by role (dollars only make sense for API-key providers; subscription runs are quota windows, not spend). Promote when a role or project needs a hard stop rather than a report — the Roles page then gets a Budgets tab and the dispatcher a refuse-on-ceiling check. Deferred 2026-09-29 from the Roles second-pass ticket.

# Feature Opportunities For Forge

This pass reverses the replacement question. It asks which features from the
recent competitive assessments would materially improve Forge without
importing another product's authority model, vocabulary, or operational
sprawl.

The findings are based on the pinned product snapshots in this directory.
They are not claims about uninspected future versions.

## Executive Conclusion

Forge is not primarily missing another orchestration engine. Its largest
competitive gap is that its stronger lifecycle and safety model is harder to
see and operate than competitors' weaker models.

The highest-value direction is therefore:

1. finish safe worktree isolation and recovery;
2. project Forge's existing truth into one operator surface;
3. make recovery, attention, and provider reachability explicit;
4. feed external review state back into the owning work;
5. only then add cheaper playbooks, presets, and outcome-informed routing.

Most of this direction is already represented in the backlog. Competitive
research should sharpen those tickets and their sequencing, not create a
parallel roadmap.

## Priority Map

| Priority | Feature | Strongest references | Forge disposition |
|---|---|---|---|
| P0 | Worktree isolation as the ordinary mutating path, with verified readiness and reliable cleanup | Claude Squad, Agent Deck, GasTown, Stoneforge | Finish FG-345, FG-356, and FG-559; do not create another ticket |
| P0 | Project-first operator cockpit with provenance and attention routing | Nimbalyst, Agent Deck, GasTown, Claude Deck | Compose FG-348, FG-349, FG-386, FG-401, FG-402, and FG-591 into one experience |
| P1 | Recovery ladder that preserves the filesystem before replacing the process | Stoneforge, Agent Orchestrator | Gap-audit current recovery; add only the missing provider-session/worktree behavior |
| P1 | External CI and review feedback bound to the exact artifact and owning task | Agent Orchestrator | Extend existing review/CI handoff rather than introduce another review engine |
| P1 | Human-facing session location and attach/resume action | Agent Deck, Claude Squad | Add a small projection over Forge launches; do not build a second terminal manager |
| P1 | Capability and reachability states that distinguish unavailable, unknown, waiting, and recoverable | Claude Deck, AgentDeck, Agent Deck | Deliver through FG-401 and the attention inbox |
| P2 | Versioned lightweight playbooks and named workflow presets | Nimbalyst, Maestro, Claude Deck | Defer until the queue and operator cockpit are usable |
| P2 | Outcome-informed model and reviewer analytics | GasTown, AgentDeck, Agent Deck | Build on existing usage/verdict/failure data; keep recommendations advisory first |
| P3 | Attributed semantic retrieval across decisions and incidents | Pinecone | Bounded derived-plane experiment only; never orchestration authority |

## 1. Finish The Isolation Product, Not Just Worktree Machinery

Several products make a new mutating session mean a new worktree by default.
The product lesson is stronger than “use Git worktrees”:

- isolation is automatic;
- setup and dependency readiness are visible;
- branch, worktree, task, process, and provider session remain distinct;
- pause or recovery preserves dirty work;
- merge happens away from the running checkout;
- cleanup is reconciled and never silently discards evidence.

Forge already has the harder publication and gate semantics. Its remaining
work is to make isolation the reliable ordinary path:

- FG-559 must make real Git history available inside a linked-worktree agent;
- FG-356 must reap orphaned and locked worktrees without discarding
  recoverable work;
- the FG-345 default-on decision must depend on both, not cleanup alone;
- readiness must fail before dispatch when required history, dependencies, or
  tools are unavailable.

### Immediate correction: FG-356 is unsafe as written

The current FG-356 scope says to force-remove every orphaned/crashed worktree
and delete its branch, preserving only `merge_conflict`. That conflicts with
Forge's existing reconciliation evidence:

- `orphaned_work_may_persist` explicitly means changed files were found and
  tells the operator to inspect that worktree;
- `oom_killed` can carry the same changed-file evidence;
- the crash matrix deliberately proves that committed and uncommitted work can
  exist only in the task worktree after a pre-merge crash.

A reaper that follows the current ticket literally can delete the evidence its
own failure message tells the operator to inspect. Unlock-first or double-force
makes that discard more reliable; it does not make it safe.

FG-356 should be amended before implementation:

1. classify a worktree as proven merged/discardable, clean but unmerged,
   dirty, or unreadable;
2. remove only proven-discardable state automatically;
3. retain dirty or unreadable worktrees, or first preserve tracked and
   untracked state in a durable, inspectable Git object/ref;
4. keep the preserved location and disposition in task/reconcile evidence;
5. make explicit operator discard or successful recovery the transition that
   permits later cleanup;
6. apply unlock-first handling only after the discard/preservation decision.

This is the clearest immediately actionable feature found in the competitive
pass. Agent Orchestrator's preservation refs are evidence that the
preserve-before-cleanup shape is practical, not a reason to copy its exact
implementation.

This is P0 because every higher-level operator feature becomes misleading if
the underlying work can still share or silently lose a checkout.

References:
[Claude Squad](claude-squad-forge-assessment.md),
[Agent Deck](agent-deck-forge-assessment.md),
[GasTown](gastown-forge-assessment.md), and
[Stoneforge](stoneforge-forge-assessment.md).

## 2. Build One Operator Cockpit From Existing Forge Truth

Nimbalyst, Agent Deck, GasTown, and Claude Deck all make fleets easier to
operate because they organize around human attention rather than raw process
names.

Forge's version should be project-first:

```text
project
  backlog and ranked queue
  active runs and campaigns
    workflow/fanout group
      task and role
        attempt, launch, worktree, provider session
        artifacts, evidence, review, publication
  attention items
```

The cockpit should answer five questions without requiring a log hunt:

1. What is running, queued, blocked, or waiting for me?
2. Why did Forge dispatch this role, runtime, model, and mount?
3. What artifact was produced, reviewed, tested, and published?
4. What recovered automatically, and what evidence survived?
5. What action is safe and available now?

This is not a new dashboard epic. The pieces already exist:

- FG-348: workflow/run map and task explain panel;
- FG-349: source/effective/recorded control-plane provenance;
- FG-386: readiness and done-audit surface;
- FG-401: provider/runtime capability matrix;
- FG-402: human attention inbox;
- FG-591: backlog, rank, queue, capacity, and derived execution state.

The feature opportunity is to make these one navigable product rather than six
adjacent pages. Every human label should link to the authoritative Forge
record behind it.

References:
[Nimbalyst](nimbalyst-forge-assessment.md),
[Agent Deck](agent-deck-forge-assessment.md),
[GasTown](gastown-forge-assessment.md), and
[Claude Deck](claude-deck-forge-assessment.md).

## 3. Add A Filesystem-First Recovery Ladder

Stoneforge's strongest lifecycle idea is its recovery order:

1. retain the recorded assignment, branch, and worktree;
2. attempt to resume the provider conversation;
3. if that is impossible, start a fresh agent in the same worktree;
4. only abandon the worktree under an explicit, evidenced disposition.

Agent Orchestrator adds two useful details:

- fence observations from superseded launches;
- preserve dirty work in a durable Git ref before destructive cleanup.

Forge already has strong stale-observation fencing, durable continuation
claims, launch reconciliation, failure kinds, and preserved task evidence.
Those are not missing features. The gap to audit is narrower:

- Is provider conversation identity recorded independently from process and
  task identity?
- Can an explicit recovery reuse the same worktree after the process is gone?
- Before orphan cleanup, can Forge preserve uncommitted tracked and untracked
  work in a durable, inspectable form?
- Does the operator see whether recovery resumed a conversation, respawned an
  agent, or merely retained evidence?

Do not file a broad “recovery v2” ticket from this research. First walk the
existing crash matrix and FG-356 behavior against those four questions. Add
only proven missing transitions.

References:
[Stoneforge](stoneforge-forge-assessment.md) and
[Agent Orchestrator](agent-orchestrator-forge-assessment.md).

## 4. Feed External Review State Back Into The Owning Work

Agent Orchestrator persists and deduplicates:

- CI failures;
- requested changes;
- unresolved review comments;
- merge conflicts.

It can then nudge the worker responsible for the change. Forge should borrow
the feedback loop while retaining stronger gate authority.

The Forge version must bind every signal to:

- repository and pull request;
- head commit or reviewed artifact identity;
- backlog item, run, and task;
- source event and observed time;
- open, superseded, resolved, or stale disposition.

The minimum useful slice is not a general GitHub inbox. It is:

1. ingest a failed required check or requested-change event;
2. attach it to the exact Forge task/artifact;
3. deduplicate repeated observations;
4. show it in the attention inbox;
5. make it available to the existing fixer/review path;
6. refuse to treat a comment or notification as a gate verdict by itself.

This is a meaningful P1 feature because it closes the loop between Forge's
durable internal evidence and the external system where publication is
actually reviewed.

Reference:
[Agent Orchestrator](agent-orchestrator-forge-assessment.md).

## 5. Make Sessions Easy To Find Without Making Tmux The Truth

Agent Deck's immediate UX advantage is mundane and valuable: a human can find
the relevant session, see whether it needs attention, and attach or resume
without deciphering internal tmux names.

Forge already records launch/session information and renders an attach
command. The minimum improvement is a project/run/task surface that provides:

- a human label;
- authoritative launch state;
- current worktree and branch;
- log tail and artifact links;
- copyable or directly invokable attach/resume action;
- explicit “session gone, work preserved” and “session gone, recovery needed”
  states.

Do not build a browser terminal, another session database, or a second
watchdog to obtain this value. Tmux remains an execution detail and liveness
signal, never task truth.

References:
[Agent Deck](agent-deck-forge-assessment.md) and
[Claude Squad](claude-squad-forge-assessment.md).

## 6. Make Capability And Reachability Honest

Claude Deck and the AgentDeck assessments reinforce a small but important UX
contract: distinguish states such as:

- ready;
- running;
- delivered but waiting;
- needs operator input;
- wakeable or resumable;
- unavailable because authentication is missing;
- unsupported by this runtime;
- unknown because Forge lacks evidence;
- offline with preserved work.

Forge should not flatten these into “failed” or infer them from a quiet pane.
FG-401 should supply provider/runtime capabilities and provenance; FG-402
should route actionable cases; the Run Map should show the resulting state in
context.

Capability adapters should advertise support for structured output, usage,
resume, hooks, browser/E2E, filesystem mode, worktrees, and host verification.
Callers must not assume that Claude, Codex, Bedrock, and other runtimes have
equivalent control surfaces.

References:
[Claude Deck](claude-deck-forge-assessment.md) and
[AgentDeck](agentdeck-forge-assessment.md).

## 7. Add Cheap Playbooks Only After The Core Surface Works

Nimbalyst and Maestro make workflows cheaper to express and adapt. Claude
Deck adds operator-friendly team presets. Forge can combine those ideas into
two deliberately different layers:

- **playbook:** versioned agent-interpreted guidance for supervised or
  exploratory work;
- **enforced workflow:** deterministic Forge transitions, gates, evidence,
  recovery, and publication.

A playbook should record its version, inputs, artifact identity, agents used,
and result. It must not bypass enforced gates. Repeatedly useful playbooks can
graduate into workflows.

Named presets can then provide approachable entry points such as “Feature
Full Pipeline,” “Docs/Research Pass,” or “Release Validation” while resolving
to the real workflow and policy objects underneath.

This remains P2. Adding workflow vocabulary before the operator queue and
dashboard are coherent would make Forge harder to understand.

References:
[Nimbalyst](nimbalyst-forge-assessment.md),
[Maestro](maestro-forge-assessment.md), and
[Claude Deck](claude-deck-forge-assessment.md).

## 8. Turn Usage Data Into Outcome Data

Agent Deck and GasTown make session or worker history visible. Forge already
has a better basis for useful analytics:

- model and token usage;
- role and runtime;
- task class and workflow;
- verdicts and findings;
- retries and failure kinds;
- gate and publication outcome;
- latency and recovery behavior.

The opportunity is not named agent personas or a leaderboard. It is answering:

- Which model/runtime succeeds for this task and role?
- Which reviewer finds confirmed defects rather than noise?
- Where does a cheaper model increase rework enough to cost more overall?
- Which workflows repeatedly fail at the same boundary?

Recommendations should initially be advisory and explain their evidence.
Routing policy remains explicit operator-controlled configuration until the
outcome data is mature and calibrated.

References:
[GasTown](gastown-forge-assessment.md),
[AgentDeck](agentdeck-forge-assessment.md), and
[Agent Deck](agent-deck-forge-assessment.md).

## 9. Keep Semantic Retrieval Derived And Attributable

Cross-project retrieval could help Forge find prior incidents, decisions,
tests, and review findings. It is valuable only if every retrieved item names
its source, revision, and generation, and the original source remains the
authority.

This is a later experiment, not a dependency of backlog, dispatch, recovery,
review, or publication. Losing the index must degrade retrieval, not Forge.

Reference:
[Pinecone](pinecone-forge-assessment.md).

## Features Forge Should Explicitly Decline

The research also identifies recurring traps:

- another orchestration database alongside Forge's;
- tmux, PTY text, or agent self-report as task truth;
- a full remote IDE before the operator cockpit works;
- mascot-heavy or duplicate lifecycle vocabulary;
- persistent worker pools before task-scoped recovery is reliable;
- prompt-only review or completion policy presented as enforcement;
- broad no-approval host access and inherited server secrets;
- shared host tmux ownership;
- mutable board columns as canonical execution state;
- semantic retrieval as a lifecycle dependency;
- configuration editors without preview, validation, backup, and receipts.

These features may look productive in a demo while weakening the exact
authority and recovery boundaries that differentiate Forge.

## Recommended Sequence

### Now

1. Finish FG-575 and the worktree safety chain.
2. Complete the DB backlog/queue slices that make one operator projection
   possible.
3. Treat FG-348, FG-401, FG-402, and FG-591 as a coherent cockpit path.

### Next

4. Run the narrow recovery gap audit described above.
5. Add the smallest external-review feedback loop.
6. Add human-facing launch/session location and attach/resume actions to the
   existing project/run/task surfaces.

### Later

7. Add playbooks and presets.
8. Add outcome-informed model/reviewer analytics.
9. Run a bounded attributed-retrieval experiment.

## Backlog Discipline

This document is not authorization to file nine new tickets.

- Existing tickets should absorb refinements when they already own the
  feature boundary.
- A genuinely missing feature should be filed only after a code/backlog gap
  walk proves it is absent.
- UI work must consume authoritative Forge state rather than create another
  lifecycle vocabulary.
- Every proposed feature should identify what Forge will stop making the
  operator do manually.

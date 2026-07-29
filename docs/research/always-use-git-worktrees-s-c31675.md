# Should forge always run each agent in its own dedicated git worktree of the project, instead of the current shared /project bind-mount? Consider isolation, concurrency/parallelism, disk and performance cost, complexity, and interaction with forge's container mount model (red read-only mounts, the macOS node_modules shadow volume, DEC-004/006/019).

> **Lifecycle:** historical research. Its open question was resolved by FG-345:
> workspace isolation is default-on for managed workflow dispatch. Read this as
> supporting evidence, not current policy.

Three lanes of research reveal a mixed picture on whether forge should always use per-agent git worktrees. The shared rw bind-mount interference risk is structurally real — concurrent blue agents do write to the same /project path with no filesystem isolation — but is narrower than the broadest framing: task artifacts are isolated to /task by construction, node_modules is partially protected on macOS by the shadow volume, and a file-independence contract governs feature build fanout. The per-worktree overhead claim is the most contested: the skeptic's direct measurement (222ms, 12MB per worktree for this repo with shared Git objects) directly challenges the 'materially slow' threshold, leaving that verdict inconclusive for larger user projects even as it appears refuted for the forge repo itself. The uncommitted-state hazard is structurally confirmed — git worktree add deterministically excludes host dirty-state — but the adversarial framing is nuanced: worktrees could reduce the live-code-mutation hazard in forge-on-forge while introducing a new stale-state problem for workflows that depend on in-progress changes being visible.

---

## The current shared rw bind-mount creates a real, present-day agent-to-agent interference risk: concurrent blue/implementer fanout agents run against the same /project path and their uncommitted edits, package installs, and generated artifacts can collide or corrupt each other.

**Verdict:** SUPPORTED  |  **Confidence:** medium

### Evidence

Both branches confirm the structural hazard. Primary: all blue agents receive projectMode 'rw' against the same PROJECT_DIR (spawn.ts:203, runNext.ts:343/979); dispatchFanoutStep issues Promise.all over batches of up to 4 concurrent containers each mounting the identical host path (runNext.ts:787-808); the feature workflow dispatches frontend-specialist, backend-specialist, security-advisor, and agentic-platform-builder concurrently against overlapping project areas; no filesystem-level write isolation exists beyond node_modules. Skeptic: confirms the rw shared-mount structure and bounded concurrency of 4 per batch (runNext.ts:777-789). Both agree the feature build fanout creates a real write-collision surface for source files, configs, build artifacts, and migration files not covered by the node_modules shadow. The claim is supported, though two scope corrections apply: (1) 'generated artifacts' for forge-controlled outputs are per-task under /task by construction, not /project, so that portion of the claim is overstated; (2) the file-independence contract in the feature workflow (each agent restricted to its plan-step's file list) provides a soft mitigation, though it is prompt-engineering discipline rather than filesystem enforcement.

### Disagreements

The skeptic introduces meaningful scope corrections: task artifacts (result.json, logs, package.md) are isolated to per-task /task directories by construction, directly challenging the 'generated artifacts can collide' framing. The skeptic also notes that prominent concurrent fanouts (research-synthesis roles) are narrative writers that do not modify /project, narrowing the hazard to specifically the feature-build fanout path. The primary does not dispute the /task isolation point. Neither branch disputes the core source-file collision risk.

## Creating a fresh git worktree per agent task on macOS with Docker Desktop (grpcfuse) imposes meaningful disk overhead and per-task dispatch latency that would materially slow concurrent fanout relative to the current shared bind-mount.

**Verdict:** INCONCLUSIVE  |  **Confidence:** medium

### Evidence

The primary makes a structural case: N concurrent worktrees require N shadow volumes, N bind-mount paths, N pre-spawn git checkout operations injected into the Promise.all dispatch wave, and N cold-start page-fault chains through grpcfuse (citing DEC-011, DEC-018, DEC-019; spawn.ts:247-259; runNext.ts:129-142). The project's demonstrated sensitivity to per-container overhead (DEC-018 fixed a 2-4x Rosetta penalty; DEC-019 eliminated grpcfuse write-back corruption) supports concern about multiplied overhead. The skeptic directly measured git worktree add --detach at 222ms for this repo, producing a 12MB checkout (762 tracked files, ~11MB; Git objects are shared by linked worktrees, not copied). With max_concurrency capped at 4, per-batch setup overhead totals ~880ms — small relative to multi-minute agent runtimes. The skeptic also notes that the shadow volume decision (DEC-019) already makes node_modules writes container-local ext4, so those writes do not travel through grpcfuse regardless of worktree scheme, undercutting the grpcfuse-compounds-per-worktree argument for the node_modules path.

### Disagreements

The branches conflict materially on the 'materially slow' threshold. Primary: structural overhead (N shadow volumes, N grpcfuse channels, pre-spawn serialization) imposes meaningful latency. Skeptic: direct measurement on this repo shows 222ms per worktree, bounded to 4 concurrent, making the per-batch overhead small relative to agent runtime; shadow volumes already prevent node_modules writes from going through grpcfuse. The disagreement cannot be fully resolved because the primary's concern applies more strongly to larger user projects (the forge repo at 762 tracked files is small; a monorepo at 50k+ files could produce qualitatively different checkout costs), while the skeptic's evidence is specific to this repo. The primary's grpcfuse-per-worktree multiplication claim is partially undercut by the shadow volume already isolating the highest-write-volume path (node_modules). Neither branch provides measurements on macOS with Docker Desktop specifically, leaving the grpcfuse bind-mount read-path cost unquantified per-worktree.

## Per-agent worktrees interact adversarially with uncommitted host changes and in-progress branch state: a worktree created off a dirty working tree captures or excludes those changes depending on implementation, risking stale or inconsistent agent state — especially in forge-on-forge scenarios where the repo being developed is the mounted project.

**Verdict:** SUPPORTED  |  **Confidence:** medium

### Evidence

Both branches confirm the core git behavior: git worktree add deterministically creates a clean HEAD checkout — untracked files, staged-but-uncommitted changes, and unstaged working-tree modifications are all excluded (skeptic observed this directly: committed tracked.txt contained base, untracked.txt was absent). The primary establishes forge-on-forge as a first-class, actively-tracked use case (docs/work-laptop-setup.md, backlog FG-245, session notes: 'forge-on-forge agent pipeline is unblocked'); upgrade.ts (lines 317-324) explicitly refuses to pull if the working tree is dirty, demonstrating system-wide treatment of uncommitted state as load-bearing; the engineer agent seed (seeds/agents/engineer/CLAUDE.md lines 28-38) explicitly describes operating against the live host working directory. The structural risk is real: if a developer has in-progress edits they intend the agent to build upon, per-agent worktrees silently give the agent a stale HEAD snapshot instead.

### Disagreements

The skeptic introduces two substantive complications. First, the behavior is deterministic exclusion rather than ambiguous capture/exclude — the primary's framing of 'captures or excludes depending on implementation' is an overstatement; git is unambiguous. Second, and most substantively, the skeptic argues that worktrees could actually REDUCE the forge-on-forge live-code-mutation hazard: docs/how-to-use-forge-across-projects.md (lines 125-131) warns that the documented forge-on-forge concern is live code mutation under the shared bind-mount causing the running forge orchestrator to behave unpredictably as its own source changes beneath it. Per-agent worktrees would prevent agent containers from mutating the host forge source, which could be a net improvement for that specific hazard. The primary does not engage with this point. The branches agree that no existing mechanism (shadow volume, rw/ro split, auth volume) provides a path for uncommitted host source changes to reach a per-agent worktree.

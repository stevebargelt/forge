# Backing up and restoring the shared forge store

`forge backup` creates, verifies, and restores point-in-time backups of the shared
control-plane store, `~/.forge/forge.db` (overridable via `FORGE_HOME`). This is the
operator runbook for FG-669. Command reference: `forge backup --help` and
`forge backup <create|verify|restore> --help`.

## What a backup is, and how sensitive it is

A backup is a byte-level snapshot of the **entire** control-plane store: every run,
task, event, verdict, review and finding, campaign, queue and readiness row, ticket /
relation / queue membership, and control-plane metadata — everything in `forge.db`,
across every project on the host, not just the one you happen to be in. It is
**exactly as sensitive as the live `forge.db`** — treat it like a credential-adjacent
artifact, not a shareable debug bundle. Backups are written owner-only (directory
`0700`, files `0600`) under `$FORGE_HOME/backups/<utc-stamp>/`, and nothing redacts
their contents (see [Secret hygiene and redaction](redaction.md#forge-backup)).

Each backup directory holds two files:

- `forge.db` — the artifact itself, a standalone single-file SQLite snapshot
  (rollback-journal mode; no `-wal`/`-shm` sidecars).
- `manifest.json` — `createdAt`, `forgeVersion`, `schemaVersion` (the artifact's
  `PRAGMA user_version`), `sourcePath`, `sourceDevice` / `sourceInode` (the source
  file's identity), `byteSize`, and `sha256`.

## Create a backup

```bash
forge backup create
```

Safe to run at any time, including while forge is actively running workflows.
`create` opens the live store **read-only** and uses SQLite's online backup API — a
page-by-page copy that is self-consistent under concurrent readers and writers. It
never migrates or otherwise mutates the store it snapshots.

```
forge backup create: wrote /Users/you/.forge/backups/2026-08-17T18-02-11-483Z/forge.db
  schemaVersion=14, bytes=2871296, sha256=…
  manifest: /Users/you/.forge/backups/2026-08-17T18-02-11-483Z/manifest.json
This backup is as sensitive as the live store (owner-only perms). Verify it with `forge backup verify …`.
```

`--source <path>` backs up a different store than this `FORGE_HOME`'s `forge.db`
(useful for backing up a store you've copied elsewhere, or scripting against a
non-default `FORGE_HOME`). `--json` emits the structured result instead of the
human-readable summary.

There is no built-in scheduler — run `forge backup create` from cron, launchd, or
your own automation if you want recurring backups. Backups accumulate under
`$FORGE_HOME/backups/`; forge does not prune old ones, so rotate them yourself.

## Verify a backup

```bash
forge backup verify ~/.forge/backups/2026-08-17T18-02-11-483Z
```

Verifies a backup directory **without touching the live store**: recomputes the
artifact's sha256 against the manifest, runs `PRAGMA integrity_check`, and applies
the same forward schema-version gate the ordinary open path uses. Never mutates
anything, and never throws — a corrupt or unreadable artifact is reported, not an
exception.

Three outcomes:

- **`ok`** — checksum, integrity, and schema version all check out. If the backup's
  schema version is older than this binary's, the report also says it will migrate
  additively on first open.
- **`corrupt`** — checksum mismatch, `integrity_check` failure, an unreadable
  artifact, or a manifest whose recorded schema version disagrees with the artifact's
  actual `user_version` (a tamper signal).
- **`incompatible_newer`** — the backup's schema version is newer than this binary
  understands. Refused, not restored; upgrade forge first.

`--json` emits the full structured result (including every reason, not just the
first). A non-`ok` outcome exits non-zero.

## Restore a backup

Restoring replaces the live `~/.forge/forge.db` with a backup. Run it without
`--confirm-quiesced` first — this only previews:

```bash
forge backup restore ~/.forge/backups/2026-08-17T18-02-11-483Z
```

The preview verifies the candidate, prints the operational contract, and mutates
nothing. Read the contract; then, once every forge process on this `FORGE_HOME` is
stopped (launches, campaigns, dashboards, interactive sessions), confirm:

```bash
forge backup restore ~/.forge/backups/2026-08-17T18-02-11-483Z --confirm-quiesced
```

### The operational contract

1. **The atomic rename is the only step that touches the live path.** The candidate
   is validated and staged, and a pre-restore safety backup of the *current* store is
   taken, all before anything on the live path changes. On any failure, `forge.db`'s
   own bytes are left byte-for-byte untouched. (This describes restoring over an
   *existing* store; restoring into a `FORGE_HOME` with no `forge.db` at all — the
   store is lost — takes a different, atomic-install path with no prior store to
   protect: see [Disaster recovery](#disaster-recovery-restoring-when-the-store-itself-is-lost).)
2. **Restore refuses a live store that still carries a `-wal`/`-shm` sidecar.** An
   un-checkpointed WAL tail is part of the live state and must never be risked in the
   swap. If you see this refusal, cleanly stop every forge process on this
   `FORGE_HOME`, then open and close forge once (any ordinary command, e.g.
   `forge status`) to checkpoint the WAL — which removes the sidecars — and retry.
3. **`--confirm-quiesced` is an assertion, not a check forge can make for you.**
   Stop every forge process on this `FORGE_HOME` first. A quiesce *proof* runs
   immediately before the swap and fails closed unless it can take exclusive access
   to the live store — but it is a backstop, not a hard fence: an uncooperative
   writer is not machine-fenced, exactly the same honest limit `forge store converge`
   documents. Your quiescence is what makes the window safe.
4. **The candidate is fully verified before anything on the live path is touched**
   (integrity, checksum, schema-version gate), and re-verified from its staged copy
   immediately before the swap. A backup whose schema version is newer than this
   binary understands is refused, not restored.
5. **Recovery:** the pre-restore safety backup printed in the restore's output can
   itself be restored the same way — `forge backup restore <that-dir> --confirm-quiesced`.

```
forge backup restore: restored /Users/you/.forge/backups/2026-08-17T18-02-11-483Z → /Users/you/.forge/forge.db
  pre-restore safety backup of the previous store: /Users/you/.forge/backups/pre-restore-2026-08-17T19-30-04-002Z
```

`--json` emits the structured result on both the preview and the confirmed paths.

### Restore holds a lock

Restore acquires `$FORGE_HOME/backup.lock` for its duration, blocking a concurrent
restore. This does not fence an uncooperative live writer — that's the quiesce
proof's job (point 3 above).

### Disaster recovery: restoring when the store itself is lost

The contract above assumes a live `forge.db` to protect. If the store is gone —
disk failure, an accidental `rm`, or a fresh host that has never had a `FORGE_HOME`
— restore the same way:

```bash
forge backup restore ~/.forge/backups/2026-08-17T18-02-11-483Z --confirm-quiesced
```

Restore creates `FORGE_HOME` if it doesn't exist and, when `forge.db` itself is
absent at the target path, takes a different path than the contract above: there is
no live store, so there is nothing to refuse-if-dirty, nothing to take a pre-restore
safety backup of, and no writer to quiesce — the output says
`(no previous store existed — no pre-restore backup taken)` rather than naming a
pre-restore directory. The candidate is still fully verified (integrity, checksum,
schema-version gate) before anything is written.

Because that "no live store" check is a snapshot in time, restore does not
blindly overwrite the target: it installs the candidate **only if the target is
still absent**, atomically. If a forge process starts and initializes `forge.db` in
the window between the check and the install — recreating exactly the live store
this path assumed didn't exist — the install is refused rather than silently
clobbering it, with a message naming the target and telling you to stop every forge
process on this `FORGE_HOME` and retry (which then takes the protected,
target-exists path above). This is a race refusal, not a sign of corruption — retry
once every forge process is confirmed stopped.

## Recovering from a bad restore or a corrupt store

Because every restore over an existing store takes a pre-restore safety backup of
whatever was live before it, undoing a restore is the same operation pointed at that
directory (a restore into a lost store had nothing to back up, so there is no
pre-restore directory to undo to — restore your most recent known-good backup
instead):

```bash
forge backup restore ~/.forge/backups/pre-restore-<ts> --confirm-quiesced
```

If the live store itself is suspect (won't open, `forge doctor` flags corruption),
restore your most recent known-good backup. `forge backup create` does not run an
integrity check before snapshotting — it opens the source read-only and copies it as
is, so it will also happily snapshot a store a *newer* forge migrated past a one-way
schema boundary (that gate is verify's and restore's job, not create's) — but it is
not a substitute for `forge backup verify` when you need to know a candidate is
actually sound before trusting it for recovery.

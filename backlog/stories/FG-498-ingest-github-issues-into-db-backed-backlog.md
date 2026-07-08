---
id: FG-498
type: story
status: active
title: "Ingest GitHub Issues into the DB-backed Forge backlog"
created: 2026-07-07
---

## Problem

Once Forge has a DB-backed active backlog (FG-496), external work sources such as GitHub Issues should be able to enter that backlog without hand-copying. Many projects already use GitHub Issues for bug reports, product requests, and lightweight planning. Forge should be able to ingest those issues into its own backlog model while preserving the external identity and avoiding duplicates.

This is separate from FG-496. FG-496 owns the active backlog source-of-truth migration. This story owns GitHub Issues as an external input/sync source.

## Goal

Provide an explicit GitHub Issues import/sync path that creates or updates Forge DB-backed backlog tickets from GitHub Issues, preserving external identity and mapping issue metadata into Forge ticket fields.

## Acceptance Criteria

- A command or configured sync path can import GitHub Issues from a configured repository into the Forge DB-backed backlog.
- Imported issues retain external identity: GitHub owner/repo, issue number, URL, state, labels, and last synced timestamp.
- Re-running import/sync is idempotent: the same GitHub issue updates the existing Forge ticket rather than creating duplicates.
- Imported issues map deterministically to Forge ticket fields: title, body/description, status, type, labels/tags, created/updated timestamps, and external link.
- Type mapping is explicit and visible. At minimum, GitHub labels/config/defaults can map issues into `bug` or `story`; the mapping can be inspected and edited in Forge after import.
- Closing or reopening behavior is defined. At minimum, Forge records GitHub issue state and either mirrors it into Forge status by configured policy or leaves it as external metadata.
- Dashboard backlog views show imported GitHub issue identity and link back to the issue.
- Authentication and API failures are surfaced clearly and do not corrupt existing imported tickets.
- Tests cover import, repeated sync/dedupe, label-to-type mapping, closed issue handling, and API failure handling with a stubbed GitHub client.

## Non-Goals

- Does not require bidirectional sync in the first cut. Pushing Forge backlog edits back to GitHub Issues can be a later story.
- Does not require Jira/Linear/other tracker integration.
- Does not require markdown export/import; FG-496 owns backlog storage, and markdown export is not core.

## Relations

- FG-496: DB-backed active backlog source of truth.


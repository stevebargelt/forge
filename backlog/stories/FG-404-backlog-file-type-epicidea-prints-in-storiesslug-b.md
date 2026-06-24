---
id: FG-404
type: story
status: active
title: backlog file --type epic|idea prints 'in stories/<slug>' but the ticket lands in epics/ or ideas/ — success message hardcodes stories/ (backlog.ts:120)
created: 2026-06-24
---

## Problem

`forge backlog file --type epic` (or `--type idea`) writes the ticket to the correct directory (epics/ or ideas/ via writeTicket -> subdirForTicket) but the success line in src/cli/commands/backlog.ts:120 hardcodes the path:

    console.log(`Created ${id} in stories/${generateSlug(title)}: ${title}`);

So the operator is told the file is in stories/ when it is actually in epics/ or ideas/. Cosmetic but misleading.

## Fix

Derive the printed subdir from the ticket's type (the same subdirForTicket / TYPE_DIRS mapping writeTicket uses) instead of the literal 'stories/'.

## Acceptance

- file --type epic prints the epics/ path; --type idea prints ideas/; default prints stories/.
- A test asserts the printed path matches the actual write location for each type.

Found while reviewing FG-398.
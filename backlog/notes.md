**Last updated 2026-07-30 (end of the autonomous evidence-led-program run).**

**The evidence-led review lifecycle is FULLY SHIPPED AND LIVE.** FG-638
(ledger, `ea6a9101`), FG-639 (coordinator, `d118aff` + pilot fixes `a6336f5`),
FG-640 (gate + feature migration + Change-0 retirement, `ed9394e`) are merged
and closed; FG-541 closed as superseded on the durable evidence mapping.
FG-647 closed on `907c899` — reviewed end-to-end by the shipped lifecycle
itself (review-7dea36bf2d1d, the first production `settled`). The `feature`
workflow declares `review_mode: evidence_led` (live generation
gen-tzoggznmyy); Change 0 is RETIRED from the policy blocks; `forge
review-loop` is deprecated in favor of `forge review start|continue`.
Also closed earlier this run: FG-608 (DB cutover — the repo backlog is
DB-authoritative), FG-645 (zero-red tranche 2), FG-642 (browser tier in
required CI). The integration tier now runs with ZERO skips anywhere
(FG-647 removed the last one).

**Open follow-ups filed by this run:**
- **FG-649** — coordinator candidate re-anchoring after post-hoc fix
  commits (bit twice: the FG-639 pilot and FG-647's first recheck; the
  fix→docs-rebind→recheck ordering routes around it, but the gap is real).
  Folds in: continue's cwd-vs-persisted-workspace resolution; fix-batch
  payload should scope to unresolved findings.
- **FG-650** — strict discovery/recheck validators refuse reviewer-authored
  outcomes carrying honest extra keys (hit three times live; accept-lens
  and retry are the workarounds; tolerate-and-record or harden prompts).

**DB state:** two backups taken this run (forge.db.pre-fg638-ledger.bak
287MB, forge.db.pre-fg639-coordinator.bak 288MB) plus the older
pre-fg608.bak. All migrations additive, integrity ok, parity guard green.

**Still carried:** ntfy DOWN all run (no push notifications). Docker Hub
token still presumed unrotated (since 2026-07-28). FG-646 explicitly
OFF-QUEUE (operator instruction). FG-609 (FG-496 Slice D) is the next
PLAN item, not yet authorized. Two stale orchestrator-session run rows
(bf2fa4, 085fdf) — do NOT cancel by age.

**Decisions:** the run's full decision log (D1-D20+) was presented in the
session's closing report; highlights needing awareness: D5 (tmux
falsification baseline 10→14 accepted on the operator's behalf — veto by
reverting 0594424e's script hunk), D9 (FORGE_CHROME_BIN authoritative-
when-set), D10 (frozen-snapshot findings resolved by DB-body annotation),
D17 (two writers never share a clone concurrently).

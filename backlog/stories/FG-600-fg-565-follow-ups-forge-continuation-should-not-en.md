---
id: FG-600
type: story
status: active
title: "FG-565 follow-ups: forge continuation should not ensureForgeDirs (read-only parity with lost-signals); F21 should drive the real forge cancel CLI not failTask(cancelled)"
created: 2026-07-21
---

---

## Folded in: FG-611 (2026-07-25)

FG-611 observed that `forge continue` is unusable for orchestrator continuations because no verb arms
an orchestrator continuation slot — only campaign/executor callers reach `recordContinuation`.

Folded here rather than tracked separately: it is the same continuation gap this ticket already owns,
and FG-611 carried no evidence or acceptance criteria of its own. If the arming verb turns out to be
separable work once this ticket is designed, split an implementable child then.

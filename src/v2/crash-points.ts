// FG-530: test-only kill injection at the runner's write boundaries.
//
// `crashPoint(name)` is a named probe placed BETWEEN adjacent writes in the
// finalize sequences (runNext.ts's post-container path, gate.ts's decision
// writes, reconcile.ts's own writes) — the windows where a real crash bites.
// The crash-matrix suite installs a hook that throws at one named point, then
// drives reconcile + runNext to a fixpoint in a fresh pass and asserts the
// lifecycle invariants held through recovery.
//
// INERT IN PRODUCTION, by construction: with no hook installed `crashPoint` is
// a single undefined field read and an optional call that never fires. No env
// parsing, no I/O, no allocation on the hot path. setCrashHookForTest is the
// ONLY writer of `crashHook`, and nothing outside a *.test.ts file calls it —
// crash-points.test.ts proves both halves (content guard + runtime inertness).
//
// A probe callsite must stay side-effect-free: it may only observe. If a probe
// ever needs to do more than call this function, it stops being a probe.

let crashHook: ((point: string) => void) | undefined;

export function crashPoint(point: string): void {
  crashHook?.(point);
}

export function setCrashHookForTest(hook: ((point: string) => void) | undefined): void {
  crashHook = hook;
}

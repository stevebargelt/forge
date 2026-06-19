**Last session ended 2026-06-19.**

**Where we left off:** Ripped out the entire headroom compression integration (committed `ae1bcc1`, 53 files, ~6700 deletions). Trigger was proving empirically that headroom is a no-op on the subscription (OAuth) path — the proxy passes /v1/messages through byte-equal by its own per-auth-mode policy; only the Bedrock-native (SigV4) route ever compressed. Full test suite green except the 3 long-standing BACKLOG-parser failures (tests 37-39).

**Picked up next:**
1. **Push + commit backlog state** (non-ticket thread) — `ae1bcc1` is unpushed, and the FG-328/FG-331 close moves (stories/ → done/) plus this notes update are uncommitted. Commit the backlog changes and push when ready.
2. **Normalize the dashboard better-sqlite3 ABI** (non-ticket loose end, no ID yet) — root pkg better-sqlite3 is built for Node 20; the `dashboard/` copy is 12.x and only works under Node 22, so dashboard tests must run under Node 22. Pre-existing, not caused by the headroom removal. File a ticket if worth fixing properly.
3. Otherwise no forced direction — pick the next priority off `forge backlog list --status active` (56 open; e.g. FG-258 provider-agnostic runtime epic, FG-291 stable-baseline epic).

**External state to remember:**
- Commit `ae1bcc1` is unpushed; backlog ticket moves + notes are uncommitted (see Picked up next #1).
- Host cleanup done: headroom-proxy binary, /tmp/headroom clone, logs all removed; `onnxruntime` (+abseil/protobuf/onnx/re2) uninstalled via brew. Rust toolchain KEPT (declined full uninstall — ~/.rustup pre-existed). `brew autoremove` collateral-removed `fzf`; it was reinstalled.
- Node ABI split: forge CLI runs on Node 20 (root better-sqlite3 ABI 115, restored via `prebuild-install` at session start); dashboard needs Node 22. The agent docker image was rebuilt without headroom-ai.
- Prior session's headroom external state (proxy binary, ~/code/headroom clone, AWS-creds-in-env startup) is all GONE/moot now.

**Decisions worth not relitigating:**
- Headroom removed entirely and intentionally — do NOT re-add it. On subscription/OAuth it compresses nothing (headroom's own CompressionPolicy skips non-PAYG auth); the implemented compression is Bedrock-native only.
- `forge learn` removed — it was a thin runtime wrapper around the external `headroom learn` binary, non-functional once headroom is gone.
- Rust kept, onnxruntime removed (user call).
- macOS from-source native builds fail on the stale Xcode-16 clang vs CLT SDK 26; fix is CLT clang 21 + SDKROOT (or prebuild-install). Saved to project memory as env_macos_native_build_toolchain.

**Shipped (for reference):**
- ae1bcc1: remove headroom compression integration (core + dashboard + docker + scripts + seeds + docs + headroom-ai dep + forge learn)
- FG-328 closed (headroom integration gaps — superseded by removal)
- FG-331 closed (Bedrock proxy AWS_ENDPOINT_URL routing — superseded by removal)
- Session-start (uncommitted, node_modules only): restored root better-sqlite3 Node-20 binding via prebuild-install so forge SQLite commands work again.

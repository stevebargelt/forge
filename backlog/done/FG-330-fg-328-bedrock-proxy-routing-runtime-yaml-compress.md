---
id: FG-330
type: story
status: done
title: "FG-328 Bedrock proxy routing: runtime YAML compression_mode not being applied"
created: 2026-06-16
closed: 2026-06-16
---

**Context:** FG-328 implemented Rust headroom-proxy with native Bedrock support. The proxy is built, installed, and running successfully. One line of code added to spawn.ts to set AWS_ENDPOINT_URL for Bedrock routing.

**Blocker:** Runtime YAML `compression_mode: proxy` field is not being loaded/applied correctly. Even when explicitly added to all runtime files, manifests show `compression_mode: null`.

**Symptoms:**
1. Added `compression_mode: proxy` to ~/.forge/runtimes/claude-bedrock.yml
2. Schema has `.default("proxy")` on line 350 of schema.ts
3. Manifests show `compression_mode: null` despite explicit YAML field
4. spawn.ts check `if (runtime.compression_mode === "proxy")` never triggers

**Investigation needed:**
- Why does RuntimeSchema.safeParse() not apply defaults or load explicit YAML fields?
- Manifest stores runtime name as "claude" not "claude-bedrock" (detection issue?)
- Does manifest capture pre-parsed YAML vs post-schema-validated object?

**Temporary workaround in spawn.ts:**
```typescript
const useProxy = runtime.compression_mode === "proxy" || runtime.auth?.mode === "env-snapshot";
```
This hardcodes proxy for Bedrock but still doesn't work because compression_mode is null.

**Verification needed once fixed:**
1. Runtime YAML loads correctly with compression_mode
2. spawn.ts proxy block executes for Bedrock agents
3. AWS_ENDPOINT_URL env var is set in agent containers
4. Bedrock requests appear in proxy logs at ~/.forge/logs/headroom-proxy.log
5. Check for model paths like POST /model/{model}/invoke

**Files modified (ready to commit):**
- src/v2/spawn.ts: Added AWS_ENDPOINT_URL for Bedrock routing
- ~/.forge/runtimes/*.yml: Added compression_mode: proxy (but not loading)
- scripts/run-headroom-proxy.sh: Updated upstream to localhost:8788 dummy

**Related:** Rust proxy IS working correctly. Health checks pass. The gap is purely runtime config loading on forge side.
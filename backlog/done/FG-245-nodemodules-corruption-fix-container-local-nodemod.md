---
id: FG-245
type: story
status: done
title: "node_modules corruption fix: container-local node_modules volume in spawn.ts (supersedes FORGE-DEC-011)"
closed: 2026-06-19
---

Root cause is grpcfuse xattr + CyberArk EDR (environmental, NOT arch — #187 does NOT fix it; orthogonal). Fix = container-local node_modules volume in spawn.ts (standard Docker shadow-volume pattern) so the container never writes native-module artifacts back through the grpcfuse project mount. Supersedes FORGE-DEC-011's 'no code fix yet' status.

VALIDATION CONSTRAINT: must be validated on the CyberArk-EDR corp Mac — the only place the silent SIGKILL triggers. A clean Mac won't prove it. Do NOT mark complete on clean-Mac testing alone.

spawn.ts is in CLAUDE.md's 'don't touch without a learnings entry' list (DEC-004/005/006/009) — write the learnings entry as part of this. Keep the change as a SEPARATE atomic commit from #187 (native arm64); they share an image-rebuild + validation sitting but are orthogonal. This is the real unblocker for forge-on-forge CODE agents (markdown-only agents like documentation-maintainer are already corruption-safe).
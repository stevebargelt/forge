// FG-569: the in-process tsx loader for the exec-not-spawn entry (bin/forge and
// every built release entry). `--import`ing this shim registers tsx's ESM hooks
// in the SAME process that then loads src/cli/index.ts and better-sqlite3 — no
// child, no second interpreter.
//
// `import "tsx"` resolves via this file's OWN location (bin/ → ../node_modules,
// or <release>/ → ./node_modules), NOT the caller's cwd, so `forge` works from
// any directory. It also uses tsx's public "." export rather than a hardcoded
// internal dist path, so a tsx upgrade that moves its loader file can't break us.
import "tsx";

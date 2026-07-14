#!/usr/bin/env bash
# FG-553 F29 probe — self-contained. Proves an ABSOLUTE pinned interpreter with a clean
# PATH is still subvertible by ambient NODE_OPTIONS: injection runs before forge, and a
# bad option blocks startup. => interpreter pinning is necessary but not sufficient.
set -u
NODE="${NODE:-$(command -v node)}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT; cd "$T"
echo "runtime: $("$NODE" -e 'process.stdout.write(process.version+" ABI "+process.versions.modules)')"
printf 'console.log("  [forge] real entry point ran");\n' > entry.mjs
printf 'console.log("  [INJECTED] attacker code ran BEFORE forge");\n' > evil.mjs
echo "### baseline (clean env, absolute interpreter)"; env -i PATH=/usr/bin:/bin "$NODE" entry.mjs
echo "### NODE_OPTIONS=--import ./evil.mjs"; env -i PATH=/usr/bin:/bin NODE_OPTIONS="--import ./evil.mjs" "$NODE" entry.mjs
echo "### NODE_OPTIONS=--not-a-real-flag (blocks startup)"; env -i PATH=/usr/bin:/bin NODE_OPTIONS="--not-a-real-flag" "$NODE" entry.mjs 2>&1 | head -1

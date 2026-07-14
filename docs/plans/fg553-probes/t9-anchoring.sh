#!/usr/bin/env bash
# FG-553 T9 probe — self-contained. Proves: a process anchors to a release at first
# resolution through `current`; swap-and-retain is safe; DELETING the anchored release
# is fatal at the next lazy load. Uniform across ESM, CJS, and native dlopen.
# Requires: node, and the repo's better-sqlite3 native binding.
set -u
NODE="${NODE:-$(command -v node)}"
BIN="$(cd "$(dirname "$0")/../../.." && pwd)/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
echo "runtime: $("$NODE" -e 'process.stdout.write(process.version+" ABI "+process.versions.modules+" "+process.platform+" "+process.arch)')"
mkfix(){ # $1 = ext (mjs|cjs)
  rm -rf "$T"/rel-A "$T"/rel-B "$T"/current; mkdir -p "$T"/rel-A "$T"/rel-B
  for R in A B; do
    cp "$BIN" "$T/rel-$R/binding.node"
    if [ "$1" = mjs ]; then
      cat > "$T/rel-$R/entry.mjs" <<EOF
import { fileURLToPath } from "node:url"; import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
export const R="$R";
export function loadNative(){ process.dlopen({exports:{}}, join(here,"binding.node")); return "$R"; }
EOF
    else
      cat > "$T/rel-$R/entry.cjs" <<EOF
const path=require("path"); module.exports.R="$R";
module.exports.lazySibling=()=>require("./sibling.cjs").R;
module.exports.loadNative=()=>{process.dlopen({exports:{}},path.join(__dirname,"binding.node"));return "$R";};
EOF
      printf 'module.exports.R="%s";\n' "$R" > "$T/rel-$R/sibling.cjs"
    fi
  done
  ln -s "$T/rel-A" "$T/current"
}
run(){ # $1=ext $2=delete(yes|no)
  if [ "$1" = mjs ]; then
    cat > "$T/probe.mjs" <<'EOF'
import { R, loadNative } from "./current/entry.mjs";
console.log(`  anchored to ${R}`);
await new Promise(r=>setTimeout(r,1500));
try { console.log(`  lazy native dlopen -> release ${loadNative()}`); }
catch(e){ console.log(`  lazy native dlopen FAILED -> ${String(e.message).split(":")[0].slice(0,42)}`); }
EOF
    "$NODE" "$T/probe.mjs" & P=$!
  else
    cat > "$T/probe.cjs" <<'EOF'
const e=require("./current/entry.cjs"); console.log(`  anchored to ${e.R}`);
setTimeout(()=>{ try{console.log(`  lazy require -> ${e.lazySibling()}`);console.log(`  native dlopen -> ${e.loadNative()}`);}
catch(x){console.log(`  lazy require FAILED -> ${x.code}`);}} ,1500);
EOF
    "$NODE" "$T/probe.cjs" & P=$!
  fi
  sleep 0.7; rm -f "$T/current"; ln -s "$T/rel-B" "$T/current"
  [ "$2" = yes ] && rm -rf "$T/rel-A"
  echo "  [swap current->rel-B$([ "$2" = yes ] && echo ' + DELETE rel-A')]"; wait $P
}
for ext in mjs cjs; do
  echo "### $ext — swap, RETAIN old release"; mkfix $ext; run $ext no
  echo "### $ext — swap AND DELETE old release"; mkfix $ext; run $ext yes
done

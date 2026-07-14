#!/usr/bin/env bash
# FG-553 Child 0 probe — self-contained. Proves the CORRECT wrapper (re-raise the child's
# own signal) preserves signal fidelity where process.exit(128) would not.
# A DIRECT observer sees the wrapper's own (code, signal); the shell later encodes a
# signalled exit as 128+signum, which is NOT itself OS-signal evidence.
set -u
NODE="${NODE:-$(command -v node)}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT; cd "$T"
echo "runtime: $("$NODE" -e 'process.stdout.write(process.version+" ABI "+process.versions.modules)')"
cat > wrapper.mjs <<'EOF'
import { spawn } from "node:child_process"; import { appendFileSync } from "node:fs";
const log=process.env.WLOG;
const child=spawn(process.execPath, process.argv.slice(2), {stdio:"inherit"});
child.on("exit",(code,signal)=>{ appendFileSync(log,`  observer: child code=${code} signal=${signal}\n`);
  if(signal){ appendFileSync(log,`  decision: RE-RAISE ${signal}\n`); process.kill(process.pid,signal); return; }
  appendFileSync(log,`  decision: EXIT ${code}\n`); process.exit(code??0); });
EOF
# direct observer of the WRAPPER: a parent node that reports (code, signal) of the wrapper itself
cat > observe.mjs <<'EOF'
import { spawn } from "node:child_process";
const [,,wlog,...rest]=process.argv;
const w=spawn(process.execPath,["wrapper.mjs",...rest],{stdio:"inherit",env:{...process.env,WLOG:wlog}});
w.on("exit",(code,signal)=>console.log(`  DIRECT observer of WRAPPER: code=${code} signal=${signal}   (shell would encode as $?=${signal?128+ ({SIGTERM:15,SIGKILL:9,SIGINT:2}[signal]??0):code})`));
EOF
echo "### child exits 0";            : > l; "$NODE" observe.mjs "$PWD/l" -e 'process.exit(0)';   cat l
echo "### child NUMERIC exit 143";   : > l; "$NODE" observe.mjs "$PWD/l" -e 'process.exit(143)'; cat l
echo "### child killed by SIGTERM";  : > l; "$NODE" observe.mjs "$PWD/l" -e 'process.kill(process.pid,"SIGTERM")'; cat l
echo "### child killed by SIGKILL";  : > l; "$NODE" observe.mjs "$PWD/l" -e 'process.kill(process.pid,"SIGKILL")'; cat l

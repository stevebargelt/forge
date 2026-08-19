// FG-543: the tiny printer docker/build.sh invokes to obtain the build-input
// digest from the SAME function doctor uses (computeBuildInputDigest), so the
// digest recorded on the image at build time cannot drift from the one the check
// recomputes. Prints the hex digest and nothing else, so build.sh can capture it
// straight into `--label forge.build-inputs.digest=<hex>`.
//
// Usage: node --import tsx src/v2/print-build-input-digest.ts <dockerDir>
// Defaults to the docker/ dir alongside this file's repo when no arg is given.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeBuildInputDigest } from "./build-input-digest.js";

const argDir = process.argv[2];
const dockerDir = argDir ?? join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "docker");
process.stdout.write(computeBuildInputDigest(dockerDir));

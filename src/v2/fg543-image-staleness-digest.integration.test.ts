// FG-543 integration coverage: the shell build path, printer process, and
// doctor-to-release report seam must all agree on the exact content digest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildInputDigest } from "./build-input-digest.js";
import { buildReleaseReport, type ImageInputs } from "./release-doctor.js";
import { gatherReleaseInputs } from "../cli/commands/doctor.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const printer = join(repoRoot, "src/v2/print-build-input-digest.ts");

function writeBuildContext(root: string, source = "alpha\n"): string {
  const dockerDir = join(root, "docker");
  mkdirSync(dockerDir, { recursive: true });
  writeFileSync(join(dockerDir, "agent-dev-worker.Dockerfile"), [
    "FROM scratch",
    "COPY alpha.txt beta.txt /app/",
    "COPY --from=builder ignored.txt /ignored/",
    "COPY corp-root.pem /certs/",
    "COPY missing.txt /missing/",
    "",
  ].join("\n"));
  writeFileSync(join(dockerDir, "alpha.txt"), source);
  writeFileSync(join(dockerDir, "beta.txt"), "beta\n");
  return dockerDir;
}

function printedDigest(dockerDir: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", printer, dockerDir], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function imageCheck(image: ImageInputs, mode: "dev" | "release" = "dev") {
  const inputs = gatherReleaseInputs("agent-dev-worker:latest", { forgeRepoDir: repoRoot }, {
    // This is doctor's public probe seam: production inspectImage supplies the
    // same ImageInputs after reading docker's image ID and label.
    inspectImage: () => image,
    probeClisInImage: () => ({}),
  }, mode);
  return buildReleaseReport(inputs).checks.find((check) => check.name.startsWith("image "))!;
}

test("FG-543 printer process produces byte-identical digest to doctor's in-process computation", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-fg543-printer-"));
  try {
    const dockerDir = writeBuildContext(root);
    const fromPrinter = printedDigest(dockerDir);
    const inProcess = computeBuildInputDigest(dockerDir);

    assert.match(fromPrinter, /^[0-9a-f]{64}$/);
    assert.equal(fromPrinter, inProcess, "the build.sh printer and doctor must record/compare identical bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FG-543 build.sh records the real printer digest as docker's forge.build-inputs.digest label", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-fg543-build-sh-"));
  const shimDir = join(root, "bin");
  const dockerArgs = join(root, "docker-args.txt");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "docker"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$@\" > \"$FORGE_DOCKER_ARGS\"\n");
  chmodSync(join(shimDir, "docker"), 0o755);
  try {
    const expected = printedDigest(join(repoRoot, "docker"));
    execFileSync("bash", [join(repoRoot, "docker/build.sh")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: join(root, "home"),
        PATH: `${shimDir}:${process.env.PATH}`,
        FORGE_DOCKER_ARGS: dockerArgs,
      },
      encoding: "utf8",
    });

    const args = readFileSync(dockerArgs, "utf8").trim().split("\n");
    assert.equal(args[0], "build", "the shim received docker build, not a synthetic dry-run command");
    assert.deepEqual(
      args.slice(1, 3),
      ["--label", `forge.build-inputs.digest=${expected}`],
      "build.sh must forward the printer's exact output as the image label",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FG-543 content changes, not mtimes, drive doctor-to-release image staleness in dev and release", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-fg543-doctor-flow-"));
  try {
    const dockerDir = writeBuildContext(root);
    const recorded = computeBuildInputDigest(dockerDir);
    const image = (currentInputDigest: string | undefined, recordedDigest: string | undefined = recorded): ImageInputs => ({
      name: "agent-dev-worker:latest", present: true, recordedDigest, currentInputDigest,
    });

    const initial = imageCheck(image(recorded));
    assert.equal(initial.status, "ok");
    assert.match(initial.detail, /build-input content.*digest/i);

    // A checkout/copy may restamp files; rewriting the same bytes must remain clean.
    writeFileSync(join(dockerDir, "alpha.txt"), "alpha\n");
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(join(dockerDir, "alpha.txt"), future, future);
    const untouchedContent = computeBuildInputDigest(dockerDir);
    assert.equal(untouchedContent, recorded, "same bytes with a fresh mtime must retain the build-input digest");
    assert.equal(imageCheck(image(untouchedContent)).status, "ok");

    writeFileSync(join(dockerDir, "alpha.txt"), "changed content\n");
    const changed = computeBuildInputDigest(dockerDir);
    assert.notEqual(changed, recorded, "a COPYed file's changed content must alter the digest");
    for (const mode of ["dev", "release"] as const) {
      const stale = imageCheck(image(changed), mode);
      assert.equal(stale.status, "warn", `changed content is stale in ${mode}`);
      assert.match(stale.detail, /STALE.*build-input content digest/i);
    }

    // Docker's missing label normalizes to undefined in inspectImage; use an
    // empty label here because imageCheck's fixture helper defaults omitted args.
    const oldImage = imageCheck(image(changed, ""));
    assert.equal(oldImage.status, "warn", "an old image without the label fails toward STALE");
    assert.match(oldImage.detail, /no build-input content digest is recorded/i);

    const unreadableTree = imageCheck(image(undefined));
    assert.equal(unreadableTree.status, "ok", "an uncomputable current digest must not become a false STALE warning");
    assert.doesNotMatch(unreadableTree.detail, /STALE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FG-577 release materialization with fresh mtimes remains clean when build-input bytes match", () => {
  const source = mkdtempSync(join(tmpdir(), "forge-fg543-source-"));
  const release = mkdtempSync(join(tmpdir(), "forge-fg543-release-"));
  try {
    const sourceDocker = writeBuildContext(source);
    const recorded = computeBuildInputDigest(sourceDocker);
    cpSync(sourceDocker, join(release, "docker"), { recursive: true });
    const future = (Date.now() + 5 * 60_000) / 1000;
    for (const file of ["agent-dev-worker.Dockerfile", "alpha.txt", "beta.txt"]) {
      utimesSync(join(release, "docker", file), future, future);
    }
    const copied = computeBuildInputDigest(join(release, "docker"));
    assert.equal(copied, recorded, "release copy has fresh mtimes but identical build inputs");

    const check = imageCheck({ name: "agent-dev-worker:latest", present: true, recordedDigest: recorded, currentInputDigest: copied }, "release");
    assert.equal(check.status, "ok");
    assert.doesNotMatch(check.detail, /STALE/);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
  }
});

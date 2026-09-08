// FG-784 integration: compose the operator-owned files with the actual HTTP boot path.
//
// The setup command's filesystem test and the adapter's injected-state listener test cover
// their individual seams. This test deliberately uses neither an injected access-state loader
// nor an injected mapping: it writes the same Forge-owned files setup creates, boots the real
// cloudflare transport, and proves an on-disk mapping edit is honored by the next request.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectRecord } from "../../queries.js";
import { maybeStartRemoteBoardFromEnv } from "../server.js";
import { resolveIdentityMappingPath } from "../mapping.js";
import { writeAccessState } from "./access-state.js";
import type { JwksCache, JwksKey } from "./jwks.js";

const TEAM = "operator";
const ISS = "https://operator.cloudflareaccess.com";
const CERTS_URL = "https://operator.cloudflareaccess.com/cdn-cgi/access/certs";
const AUD = "a".repeat(64);
const EMAIL = "operator@example.com";
const NOW_MS = Date.UTC(2026, 0, 1);
const NOW_S = NOW_MS / 1000;
const keypair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key: JwksKey = { ...keypair.publicKey.export({ format: "jwk" }), kid: "operator-key" };

const homes: string[] = [];
const servers: Server[] = [];
after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function signAccessJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: ISS,
    aud: AUD,
    exp: NOW_S + 3600,
    nbf: NOW_S - 60,
    iat: NOW_S - 60,
    email: EMAIL,
    sub: "access-user",
  })).toString("base64url");
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(keypair.privateKey).toString("base64url")}`;
}

function cache(): JwksCache {
  return {
    getKeys: async () => [key],
    refreshForUnknownKid: async () => [key],
    certsUrl: CERTS_URL,
  };
}

function waitForListening(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve(server.address() as AddressInfo);
    server.once("listening", () => resolve(server.address() as AddressInfo));
    server.once("error", reject);
  });
}

test("setup state and a live mapping edit respectively grant then revoke the booted Cloudflare board", async () => {
  const home = mkdtempSync(join(tmpdir(), "fg784-setup-state-"));
  homes.push(home);
  const env = { FORGE_HOME: home } as NodeJS.ProcessEnv;
  const projectDir = join(home, "checkout");

  // This is the non-secret deployment record setup persists; the default adapter loader reads it
  // from FORGE_HOME for every request.
  writeAccessState({
    version: 1,
    publicHostname: "board.example.com",
    accessTeamDomain: TEAM,
    accessAud: AUD,
    loopbackPort: 8025,
    target: "http://127.0.0.1:8025",
    url: "https://board.example.com",
    cloudflaredConfigPath: join(home, "remote-board-cloudflared.yml"),
  }, env);
  writeFileSync(resolveIdentityMappingPath(env), `version: 1\nidentities:\n  - login: ${EMAIL}\n    project: project-cf\n    capabilities: [read]\n`);

  const project = {
    key: "project-cf",
    projectDirs: [projectDir],
    projectDir,
    primaryCheckout: projectDir,
    checkouts: [],
  } as unknown as ProjectRecord;
  const server = maybeStartRemoteBoardFromEnv(
    {
      ...env,
      FORGE_DASHBOARD_REMOTE: "1",
      FORGE_DASHBOARD_REMOTE_PORT: "0",
      FORGE_DASHBOARD_REMOTE_TRANSPORT: "cloudflare",
    },
    {
      lookupProject: (projectKey) => (projectKey === project.key ? project : undefined),
      transportDeps: { jwksCache: cache(), now: () => NOW_MS },
    },
  );
  assert.ok(server, "cloudflare state + selector boot the dedicated listener");
  servers.push(server);
  const address = await waitForListening(server);
  assert.match(address.address, /^(127\.|::1$)/, "the configured tunnel origin remains loopback-only");

  const request = () => fetch(`http://127.0.0.1:${address.port}/api/board`, {
    headers: { "cf-access-jwt-assertion": signAccessJwt() },
  });
  const granted = await request();
  assert.notEqual(granted.status, 401, "the persisted Access configuration and mapping authorize a verified browser request");

  // Mapping is intentionally re-read per request: remove the grant without restarting the
  // listener, then the same still-valid Access token must carry no project data.
  writeFileSync(resolveIdentityMappingPath(env), "version: 1\nidentities: []\n");
  const revoked = await request();
  assert.equal(revoked.status, 401, "the next request honors mapping revocation without a dashboard restart");
  const body = await revoked.json();
  assert.equal(body.state, "unauthorized");
  assert.equal(body.board, null, "a revoked identity receives no board data");
});

// FG-845 — GIT ATTRIBUTION SET FROM THE DASHBOARD, THROUGH THE CLI'S OWN VERBS.
//
// Two ACTION_ROUTES rows (action-mutation.ts) land here: `POST /api/ai-attribution/project`
// and `POST /api/ai-attribution/host`. Each shells exactly one `forge config` verb with a
// fixed argv and writes no file itself — the CLI's read-modify-write (src/v2/ai-attribution.ts)
// is the only writer, and it logs `config.ai_attribution_changed` with the actor.
//
//  * project — body { projectKey, projectDir?, mode: suppress | allow | inherit }. `--project`
//    is the registry's own checkout (projectDir only selects among the project's checkouts,
//    never a caller path). suppress | allow → `config set ai-attribution <mode> --project
//    <checkout> --actor dashboard`; inherit → `config unset ai-attribution --project
//    <checkout> --actor dashboard`.
//  * host — body { mode: suppress | allow } → `config set ai-attribution <mode> --host
//    --actor dashboard`.
//
// Attribution is not a trust gate, so there is no proposal window, typed confirmation or
// rationale; the client's Preview → Confirm is the explicit act. Never `--force`.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRecord } from "./queries.js";
import { describeAiAttribution } from "../../src/v2/ai-attribution.js";
import type { AiAttributionView } from "../../src/v2/config-graph-types.js";
import { resolveCheckoutDir } from "./queue-mutation.js";
import {
  CHILD_TIMEOUT_MS,
  MAX_CONCURRENT_MUTATIONS,
  MAX_REPORTED_STDERR,
  assertOperand,
  cliRefusal,
  guardMutationPost,
  isRefusal,
  readBody,
  refuse,
  resolveForgeBinary,
  runForgeVerb,
  send,
  withMutationSlot,
  type MutationRefusal,
} from "./mutation-guards.js";

export type AiAttributionAction = "ai-attribution-project" | "ai-attribution-host";

export const AI_ATTRIBUTION_PATH = /^\/api\/ai-attribution\/(project|host)$/;

export const PROJECT_ATTRIBUTION_CHOICES = ["suppress", "allow", "inherit"] as const;
export const HOST_ATTRIBUTION_CHOICES = ["suppress", "allow"] as const;

export type ProjectAttributionChoice = (typeof PROJECT_ATTRIBUTION_CHOICES)[number];
export type HostAttributionChoice = (typeof HOST_ATTRIBUTION_CHOICES)[number];

const MAX_BODY_BYTES = 4 * 1024;

export type AiAttributionRequest =
  | { action: "ai-attribution-project"; projectKey: string; projectDir: string | undefined; mode: ProjectAttributionChoice }
  | { action: "ai-attribution-host"; mode: HostAttributionChoice };

const FIELDS: Record<AiAttributionAction, readonly string[]> = {
  "ai-attribution-project": ["projectKey", "projectDir", "mode"],
  "ai-attribution-host": ["mode"],
};

/** PURE: the body checked against the one shape each route takes. */
export function parseAiAttributionRequest(action: AiAttributionAction, body: unknown): AiAttributionRequest | MutationRefusal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse(400, "the request body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;
  const allowed = FIELDS[action];
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extra.length > 0) return refuse(400, `this route takes ${allowed.join(", ")}; refusing ${extra.join(", ")}. The dashboard never passes --force.`);
  const mode = input["mode"];
  if (action === "ai-attribution-host") {
    if (typeof mode !== "string" || !(HOST_ATTRIBUTION_CHOICES as readonly string[]).includes(mode)) {
      return refuse(400, `mode must be one of ${HOST_ATTRIBUTION_CHOICES.join(", ")} (got ${JSON.stringify(mode)}).`);
    }
    return { action, mode: mode as HostAttributionChoice };
  }
  if (typeof mode !== "string" || !(PROJECT_ATTRIBUTION_CHOICES as readonly string[]).includes(mode)) {
    return refuse(400, `mode must be one of ${PROJECT_ATTRIBUTION_CHOICES.join(", ")} (got ${JSON.stringify(mode)}).`);
  }
  const projectKey = input["projectKey"];
  if (typeof projectKey !== "string" || projectKey.trim() === "") {
    return refuse(400, "projectKey is required: the registered project whose .forge/config.yml this is.");
  }
  const projectDir = input["projectDir"];
  if (projectDir !== undefined && projectDir !== null && typeof projectDir !== "string") return refuse(400, "projectDir must be a string.");
  return { action, projectKey, projectDir: projectDir ?? undefined, mode: mode as ProjectAttributionChoice };
}

export type BuiltAiAttribution = { ok: true; verb: "config"; argv: string[]; command: string };

/** THE ARGV BUILDER. The mode comes from the closed set above, the checkout from the
 *  registry; nothing else reaches argv. */
export function buildAiAttributionArgv(
  request: AiAttributionRequest,
  checkout: string | undefined,
  actor: string,
): BuiltAiAttribution | MutationRefusal {
  if (request.action === "ai-attribution-host") {
    const argv = ["config", "set", "ai-attribution", request.mode, "--host", "--actor", actor];
    return { ok: true, verb: "config", argv, command: `forge config set ai-attribution ${request.mode} --host` };
  }
  if (checkout === undefined || !isAbsolute(checkout)) return refuse(500, "the resolved project checkout is not an absolute path.");
  const dash = assertOperand(checkout, "the resolved project checkout");
  if (dash) return dash;
  if (request.mode === "inherit") {
    return {
      ok: true,
      verb: "config",
      argv: ["config", "unset", "ai-attribution", "--project", checkout, "--actor", actor],
      command: "forge config unset ai-attribution",
    };
  }
  return {
    ok: true,
    verb: "config",
    argv: ["config", "set", "ai-attribution", request.mode, "--project", checkout, "--actor", actor],
    command: `forge config set ai-attribution ${request.mode}`,
  };
}

/** The checkout a project card's attribution describes: the primary checkout while it
 *  exists, else the first that does; null when none is on disk. */
export function attributionCheckout(project: Pick<ProjectRecord, "primaryCheckout" | "checkouts">): string | null {
  const existing = project.checkouts.filter((checkout) => checkout.exists);
  return (existing.find((checkout) => checkout.projectDir === project.primaryCheckout) ?? existing[0])?.projectDir ?? null;
}

/** FG-845: GET /api/projects' cards carry their checkout's attribution — the same
 *  describeAiAttribution the Config row reads, one call per checkout per request. */
export function withAiAttribution<T extends Pick<ProjectRecord, "primaryCheckout" | "checkouts">>(
  projects: T[],
  describe: (checkout: string) => AiAttributionView = describeAiAttribution,
): Array<T & { aiAttribution: AiAttributionView | null }> {
  const cache = new Map<string, AiAttributionView>();
  return projects.map((project) => {
    const checkout = attributionCheckout(project);
    if (checkout === null) return { ...project, aiAttribution: null };
    let view = cache.get(checkout);
    if (!view) {
      view = describe(checkout);
      cache.set(checkout, view);
    }
    return { ...project, aiAttribution: view };
  });
}

function forgeHome(): string {
  return process.env["FORGE_HOME"] ?? join(homedir(), ".forge");
}

export type AiAttributionMutationContext = {
  /** Resolved only after every header and body guard has passed. */
  resolveProject: (projectKey: string) => ProjectRecord | undefined;
  actor: string;
};

export async function handleAiAttributionMutation(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context: AiAttributionMutationContext,
): Promise<void> {
  const m = path.match(AI_ATTRIBUTION_PATH);
  if (!m) {
    send(res, 404, { ok: false, error: "not found" });
    return;
  }
  const action = `ai-attribution-${m[1]}` as AiAttributionAction;

  const headerRefusal = guardMutationPost(req, "attribution changes");
  if (headerRefusal) {
    send(res, headerRefusal.status, { ok: false, action, error: headerRefusal.error });
    return;
  }
  const body = await readBody(req, MAX_BODY_BYTES);
  if (isRefusal(body)) {
    send(res, body.status, { ok: false, action, error: body.error });
    return;
  }
  let parsed: unknown;
  try {
    parsed = body.text.trim() === "" ? {} : JSON.parse(body.text);
  } catch {
    send(res, 400, { ok: false, action, error: "the request body is not valid JSON." });
    return;
  }
  const request = parseAiAttributionRequest(action, parsed);
  if (isRefusal(request)) {
    send(res, request.status, { ok: false, action, error: request.error });
    return;
  }

  let checkout: string | undefined;
  if (request.action === "ai-attribution-project") {
    const owner = context.resolveProject(request.projectKey);
    if (!owner) {
      send(res, 404, { ok: false, action, error: `no registered project has the key ${JSON.stringify(request.projectKey)}.` });
      return;
    }
    const dir = resolveCheckoutDir(owner, request.projectDir);
    if (isRefusal(dir)) {
      send(res, dir.status, { ok: false, action, error: dir.error });
      return;
    }
    checkout = dir;
  }

  const built = buildAiAttributionArgv(request, checkout, context.actor);
  if (isRefusal(built)) {
    send(res, built.status, { ok: false, action, error: built.error });
    return;
  }
  if (built.argv[0] !== "config" || built.argv[2] !== "ai-attribution" || built.argv.includes("--force")) {
    send(res, 500, { ok: false, action, error: "refusing to spawn an unregistered attribution argv." });
    return;
  }
  const binary = resolveForgeBinary();
  if (isRefusal(binary)) {
    send(res, binary.status, { ok: false, action, error: binary.error });
    return;
  }

  const result = await withMutationSlot(() => runForgeVerb(binary.path, built.argv, checkout ?? forgeHome()));
  if (result === null) {
    send(res, 503, { ok: false, action, error: `too many dashboard mutations in flight (${MAX_CONCURRENT_MUTATIONS}); retry in a moment.` });
    return;
  }
  const summary = {
    action,
    verb: built.command,
    mode: request.mode,
    ...(checkout ? { checkout } : {}),
    exitCode: result.code,
    stdout: result.stdout.slice(-MAX_REPORTED_STDERR).trim(),
  };
  if (result.timedOut) {
    send(res, 504, { ok: false, ...summary, error: `\`${built.command}\` did not finish within ${CHILD_TIMEOUT_MS}ms.` });
    return;
  }
  if (result.code !== 0) {
    send(res, 409, { ok: false, ...summary, error: cliRefusal(result, built.command.replace(/^forge /, "")) });
    return;
  }
  // The CLI applies the change before it records the audit event; a failed record exits 0
  // with a `warning: applied, but …` stderr line, which the response carries beside the result.
  const auditWarning = result.stderr.split("\n").find((line) => line.startsWith("warning: applied, but "));
  send(res, 200, { ok: true, ...summary, ...(auditWarning ? { auditWarning: auditWarning.slice(0, MAX_REPORTED_STDERR) } : {}) });
}

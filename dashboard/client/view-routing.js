const VIEWS = new Set(["activity", "projects", "verify", "usage", "ops", "governance", "backlog", "reviews", "queue", "shipping", "campaigns", "control-plane", "run-map"]);

// FG-348: the run-map view is PARAMETERIZED by runId — `#run-map/<runId>` — so a
// run is deep-linkable and reachable from the activity feed. Everything else is a
// flat `#<view>` hash. initialView returns the view NAME only; runIdFromHash
// extracts the runId argument (or null).

export function initialView(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const slash = raw.indexOf("/");
  const view = slash === -1 ? raw : raw.slice(0, slash);
  return VIEWS.has(view) ? view : "home";
}

export function runIdFromHash(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  const slash = raw.indexOf("/");
  if (slash === -1) return null;
  if (raw.slice(0, slash) !== "run-map") return null;
  const id = raw.slice(slash + 1);
  return id ? decodeURIComponent(id) : null;
}

export function hashForView(view, runId) {
  if (view === "home") return "";
  if (view === "run-map" && runId) return `#run-map/${encodeURIComponent(runId)}`;
  return `#${view}`;
}

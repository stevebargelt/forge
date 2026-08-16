const VIEWS = new Set(["activity", "projects", "verify", "usage", "ops", "governance", "backlog", "reviews", "queue", "shipping"]);

export function initialView(hash) {
  const view = String(hash ?? "").replace(/^#/, "");
  return VIEWS.has(view) ? view : "home";
}

export function hashForView(view) {
  return view === "home" ? "" : `#${view}`;
}

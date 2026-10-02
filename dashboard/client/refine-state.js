// FG-847 — the Refine panel's decisions, without a DOM: which sections the readiness gaps
// name, the editor's seed, the live checklist and the client-side Save refusal.
//
// The section test mirrors evaluateReadiness (src/readiness/readiness.ts): a `#`–`###`
// heading names a section (case-insensitive), Goal may be spelled Expected behavior, and
// Acceptance Criteria needs a bullet. The SERVER's verdict after Save is still the
// authority — this only stops a Save that cannot help. A seeded placeholder does not count
// as content: the checklist ticks a section once the operator has written it.

export const REFINE_SECTIONS = Object.freeze([
  Object.freeze({ key: "problem", gap: /problem/i, names: ["problem"], heading: "## Problem", label: "## Problem", placeholder: "<what breaks today, and where it was seen>", bullet: false }),
  Object.freeze({ key: "goal", gap: /goal|expected behavior/i, names: ["goal", "expected behavior"], heading: "## Goal", label: "## Goal (or ## Expected behavior)", placeholder: "<state the observable end state>", bullet: false }),
  Object.freeze({ key: "acceptance", gap: /acceptance criteria/i, names: ["acceptance criteria"], heading: "## Acceptance Criteria", label: "## Acceptance Criteria (with bullets)", placeholder: "- <a testable criterion>", bullet: true }),
]);

/** The outcomes that permit an enqueue (QUEUEABLE_OUTCOMES in src/store/queue.ts). */
export function isQueueable(outcome) {
  return outcome === "ready" || outcome === "exploratory";
}

/** The sections the readiness gaps name, in REFINE_SECTIONS order. */
export function sectionsForGaps(gaps) {
  const list = Array.isArray(gaps) ? gaps : [];
  return REFINE_SECTIONS.filter((section) => list.some((gap) => typeof gap === "string" && section.gap.test(gap)));
}

/** `# Name` … content, by lowercased name — evaluateReadiness's extractSections. */
export function bodySections(text) {
  const sections = new Map();
  let name = null;
  let lines = [];
  const flush = () => {
    if (name !== null) sections.set(name.toLowerCase(), lines.join("\n").trim());
  };
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m) {
      flush();
      lines = [];
      name = m[1].trim();
    } else if (name !== null) {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

function sectionContent(sections, section) {
  for (const name of section.names) if (sections.has(name)) return sections.get(name);
  return undefined;
}

/** Whether the text carries the section with content of the operator's own. */
export function sectionSatisfied(text, section, sections = bodySections(text)) {
  const content = sectionContent(sections, section);
  if (content === undefined) return false;
  const own = content
    .split("\n")
    .filter((line) => line.trim() !== section.placeholder && line.trim() !== "")
    .join("\n");
  if (own.trim() === "") return false;
  return section.bullet ? /^\s*(?:[-*+] |\d+\. )/m.test(own) : true;
}

/** The live checklist: one row per section the gaps named, ticked once satisfied. */
export function refineChecklist(text, sections) {
  const parsed = bodySections(text);
  return sections.map((section) => ({ key: section.key, label: section.label, done: sectionSatisfied(text, section, parsed) }));
}

/** Null when Save may go; otherwise the refusal naming what is still missing. */
export function saveRefusal(text, sections) {
  const missing = refineChecklist(text, sections).filter((row) => !row.done).map((row) => row.label);
  if (missing.length === 0) return null;
  return `Not saved — still missing: ${missing.join("; ")}. Write ${missing.length === 1 ? "it" : "them"} (the placeholder does not count), then save.`;
}

/** THE EDITOR'S SEED: the current body with each gap's section that is ABSENT inserted
 *  (heading + one-line placeholder) above the first existing heading — or after the body
 *  when it has no heading, so its free text never becomes a section's content. A section
 *  whose heading exists but is empty is left for the operator to fill. */
export function seedBody(body, sections) {
  const text = String(body ?? "");
  const present = bodySections(text);
  const block = sections
    .filter((section) => sectionContent(present, section) === undefined)
    .map((section) => `${section.heading}\n\n${section.placeholder}\n`)
    .join("\n");
  if (block === "") return text;
  const lines = text.split("\n");
  const first = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  if (first === -1) return text.trim() === "" ? block : `${text.replace(/\s+$/, "")}\n\n${block}`;
  const before = lines.slice(0, first).join("\n").replace(/\s+$/, "");
  const after = lines.slice(first).join("\n");
  return `${before ? `${before}\n\n` : ""}${block}\n${after}`;
}

/** The outcome a successful Save becomes (FG-846's inline outcome): applied when the re-run
 *  verdict permits an enqueue — the panel then offers Enqueue now — else still a refusal
 *  naming the remaining gaps. */
export function savedOutcome(ticketId, payload) {
  const readiness = payload && payload.readiness ? payload.readiness : null;
  const verdict = readiness ? readiness.outcome : null;
  const revision = payload && typeof payload.revision === "number" ? payload.revision : readiness ? readiness.revision : null;
  const at = revision === null || revision === undefined ? "its new revision" : `r${revision}`;
  const ready = isQueueable(verdict);
  const gaps = readiness && Array.isArray(readiness.gaps) ? readiness.gaps : [];
  return {
    ok: ready,
    kind: "saved",
    ticketId,
    verdict,
    revision,
    readiness,
    message: ready
      ? `Saved; ${ticketId} evaluates ${verdict} at ${at}.`
      : `Saved as ${at}, but ${ticketId} still evaluates ${verdict ?? "unknown"}${gaps.length ? `: ${gaps.join("; ")}` : ""}.`,
  };
}

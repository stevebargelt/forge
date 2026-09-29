// FG-824: the ONE formatter module of the dashboard client — ids, shas, durations, token
// counts and timestamps. Every other client module calls these rather than slicing a sha,
// dividing a count or calling toLocale*String itself, so a value reads the same on every
// surface. dashboard/src/fg824-format.test.ts fails when another module formats one of
// these directly.
//
// Identifiers render in one monospace class, MONO_CLASS, and a shortened one always keeps
// its full value in `title`.

export const MONO_CLASS = "mono";

/** Wall-clock duration. Sub-minute shows seconds; longer keeps seconds for at-a-glance
 *  precision (matches `forge show`'s duration intent). Extracted from main.js by FG-694 so
 *  a unit test can import it. */
export function formatDuration(ms) {
  if (ms == null) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

/** A sha shortened for display (12 by default), or an em dash for none. */
export function shortSha(sha, length = 12) {
  if (sha === null || sha === undefined || sha === "") return "—";
  return String(sha).slice(0, length);
}

/** An id shortened to `max` characters with an ellipsis; short ids pass through. */
export function shortId(id, max = 28) {
  if (id === null || id === undefined || id === "") return "—";
  const text = String(id);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How an identifier renders: shortened text, the full value as its title, one class. */
export function idDisplay(value, kind = "id") {
  const text = kind === "sha" ? shortSha(value) : shortId(value);
  return { text, title: value === null || value === undefined ? "" : String(value), class: MONO_CLASS };
}

/** A token (or request) count: 950, 1.2K, 3.4M, 1.25B. */
export function formatTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(Math.round(n));
}

function parseTime(iso) {
  if (iso === null || iso === undefined || iso === "") return null;
  const ms = typeof iso === "number" ? iso : new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** "42s ago", "5m ago", "3h ago", "2d ago" — or an em dash for no time. */
export function formatRelativeTime(iso, now = Date.now()) {
  const then = parseTime(iso);
  if (then === null) return "—";
  const sec = Math.floor((now - then) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** The absolute local timestamp, the title a relative time carries. */
export function formatTimestamp(iso, fallback = "—") {
  const ms = parseTime(iso);
  return ms === null ? fallback : new Date(ms).toLocaleString();
}

/** Local wall-clock time of day. `options` pass through to toLocaleTimeString. */
export function formatClock(iso, options = undefined, fallback = "—") {
  const ms = parseTime(iso);
  return ms === null ? fallback : new Date(ms).toLocaleTimeString([], options);
}

/** A timestamp as it renders: relative text, absolute title. */
export function timestampDisplay(iso, now = Date.now()) {
  return { text: formatRelativeTime(iso, now), title: formatTimestamp(iso, ""), class: MONO_CLASS };
}

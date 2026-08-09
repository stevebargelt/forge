// Wall-clock duration formatting, shared by the client views.
//
// Extracted from main.js by FG-694 so the Current-activity view can render an
// elapsed time without main.js — which calls `render()` at module scope and so
// cannot be imported by a unit test — and without a second hand-written copy of
// the format. One format, one place: `12m 3s`, not `12m 3s` here and `12m` there.

/** Sub-minute shows seconds; longer keeps seconds for at-a-glance precision
 *  (matches `forge show`'s duration intent). */
export function formatDuration(ms) {
  if (ms == null) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

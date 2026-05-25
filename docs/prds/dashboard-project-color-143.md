# SPEC — Dashboard per-project label + color (#143)

**Status:** draft, awaiting confirmation
**Backlog linkage:** closes #143. Composite with #144 (iTerm2 background tint — same color source, deferred research).

## Objective

The dashboard ships as a cross-project survey surface — runs from every project on the host land in the same activity feed and in-flight strip. Today, `projectLabel` *does* render (as `faint mono` text mixed with the workflow + phase + taskId line), but it's not visually distinct — easy to gloss over, hard to scan when several projects are active simultaneously.

After this spec lands:

- Every task card and in-flight row shows a **colored chip** with the project's basename at the front of the head row. Bright enough to scan, small enough not to dominate.
- Color source is **`<projectDir>/.vscode/settings.json`** → `workbench.colorCustomizations["titleBar.activeBackground"]` when present. Matches the color the user already assigns to that project's VS Code titlebar; reuses an existing mental model.
- **Fallback** when `.vscode/settings.json` is missing / malformed / lacks the key: a deterministic hash of `projectDir` → HSL hue with fixed saturation/lightness tuned for the dashboard's dark background.
- Server-side cache by `projectDir` so the `.vscode` lookup runs at most once per project per dashboard process.

## Out of scope (deferred)

- **Project filter UI** (chip row / dropdown to "show only this project"). Worth doing later if label+color alone isn't enough; for now the scan affordance is the win.
- **Reading other `.vscode` values** (e.g. `titleBar.activeForeground` for chip text color). The dashboard chooses its own text color for legibility against the project color. Just background source.
- **Dashboard-side color override config.** The .vscode source + hash fallback covers the natural case. If a user wants a different color than their editor, they can edit their `.vscode/settings.json` (single source of truth).
- **Hot-reload of the color when `.vscode/settings.json` changes.** Cache invalidates on dashboard restart. User-initiated `forge dashboard start` is the refresh mechanism.
- **Color contrast computation.** Could compute brightness of the project color and pick black or white text accordingly. Punt — projects in practice will use light-on-dark colors that work with white chip text. If a project picks a light pastel and text becomes unreadable, file a follow-up.
- **#144 iTerm2 tinting.** Same color source, different rendering target. Filed separately.

## Commands (no CLI changes)

No new CLI surface. Dashboard auto-resolves colors at query time. Refresh = restart `forge dashboard start`.

## Project structure (files touched)

### Server-side (TypeScript)

- `dashboard/src/project-meta.ts` — NEW. Pure resolution helper:
  ```ts
  export type ProjectMeta = { label: string; color: string };
  export function resolveProjectMeta(projectDir: string | null): ProjectMeta | null;
  ```
  - `null` projectDir → `null` return (caller renders the existing `—` placeholder).
  - Otherwise: reads `<projectDir>/.vscode/settings.json` if it exists, extracts `workbench.colorCustomizations.titleBar.activeBackground`. Falls back to `hashColor(projectDir)` if missing / malformed / key absent.
  - Caches results in a module-level `Map<string, ProjectMeta>` keyed by `projectDir`. Cache lives for the lifetime of the dashboard process.
  - `label` = `path.basename(projectDir)`.

- `dashboard/src/queries.ts` — MODIFIED:
  - `ActivityEntry` and `InFlightEntry` gain `projectLabel: string | null` and `projectColor: string | null` fields.
  - `recentActivity` and `inFlight` populate them via `resolveProjectMeta(projectDir)`.
  - No SQL change — the `projectDir` is already selected.

### Client-side (JavaScript)

- `dashboard/client/main.js` — MODIFIED:
  - Replace the inline `projectLabel` text-in-faint-mono-line with a `<ProjectChip>` component placed at the start of each card's `head` row (FeedCard) and the start of the InFlightItem row.
  - `ProjectChip` reads `entry.projectLabel` + `entry.projectColor` and renders a small pill with inline `background-color` style and white text. Title attribute on hover = full `projectDir` (still need this for disambiguation when two projects have the same basename).
  - Keep the existing `faint mono` line for `${workflow} · ${phase}` / `${phase} · ${taskId}` but drop `projectLabel` from it (since it's now in the chip).

- `dashboard/src/shell.ts` — MODIFIED:
  - Add CSS for `.project-chip`: small padding, rounded corners, white text, font-size ~11px, margin-right for spacing.

### Tests

- `dashboard/src/project-meta.test.ts` — NEW. Pure-function tests:
  - `resolveProjectMeta: returns null for null projectDir`
  - `resolveProjectMeta: reads color from .vscode/settings.json when present`
  - `resolveProjectMeta: falls back to hash color when .vscode/settings.json is missing`
  - `resolveProjectMeta: falls back to hash color when .vscode/settings.json is malformed JSON`
  - `resolveProjectMeta: falls back to hash color when colorCustomizations.titleBar.activeBackground is absent`
  - `resolveProjectMeta: caches results (second call doesn't re-read disk — verify via a spy or by writing the file after the first call)`
  - `resolveProjectMeta: hash fallback is deterministic across calls and yields a valid CSS color string`
  - `resolveProjectMeta: label is the basename of projectDir`

  Use a tmpdir + writeFileSync pattern (same as `upgrade.test.ts`) for the .vscode fixtures.

### Docs (light)

- `docs/concepts.md` — verify the **Project** entry mentions how the dashboard surfaces project identity; if it doesn't, add a one-liner.
- Nothing else needs updating — the dashboard README is internal-facing; the change is UX, not setup.

## Code style

- TypeScript strict mode for `project-meta.ts`. Pure module; no side effects beyond the cache map.
- ES modules; `.js` suffix on imports.
- `dashboard/client/*.js` stays plain JS (no TS, no build) — matches existing pattern.
- No comments unless WHY is non-obvious. The cache deserves a one-liner ("cache lives for process lifetime; restart dashboard to pick up .vscode changes").
- Hash function: a simple FNV-1a over the projectDir string yielding a 32-bit number → `hue = result mod 360`. Saturation = 65%, lightness = 50%. No external dependency.

## Testing strategy

Baseline: 268/268 tests after the notify-env-loader commit (`3545138`).

### New tests (covered above)
- ~7-8 unit tests for `resolveProjectMeta`.

### Manual verification

After implementation:

1. `forge dashboard start` — opens at http://127.0.0.1:8024.
2. Confirm cards in the activity feed show a colored chip with the project's basename at the front of the head row.
3. For a project that has `.vscode/settings.json` with a `titleBar.activeBackground` (e.g. `~/code/forge` itself, where I saw earlier the user has `#6633CC`), the chip color should match that exact color.
4. For a project without `.vscode/settings.json`, the chip color should be a stable auto-generated color (same color every time the page is refreshed).
5. Hover the chip — full `projectDir` should appear in the tooltip.
6. The `faint mono` line below should no longer show `projectLabel` (now in the chip).
7. In-flight strip rows also show the chip.

### Regression check
- `npm --workspace=dashboard run typecheck` clean.
- `npm test` — 268/268 + new ~8 tests pass.
- All existing dashboard surfaces (task detail view, etc.) still render correctly.

## Boundaries

### Always do
- Cache `.vscode/settings.json` reads per projectDir. Don't hit the disk on every API request.
- Fall back to hash color silently — never surface a "missing .vscode/settings.json" error to the user; that file is optional.
- Pass the color through verbatim (it's a CSS color string; the browser handles validation).
- Run `npm --workspace=dashboard run typecheck` before commit.

### Ask first about
- Adding a separate user-config layer for project colors (dashboard-side override). Out of scope for this spec.
- Hot-reloading on `.vscode/settings.json` change (file watcher in the server). Out of scope.
- Changing the chip placement / shape beyond what's described (e.g. left-edge bar instead of head chip). Spec calls for chip.

### Never do
- Read or write any other file from `<projectDir>` beyond `.vscode/settings.json`. Dashboard's filesystem read surface stays minimal.
- Couple this work to anything in #144 (iTerm2 tinting). Same color source, different rendering target; should compose later without requiring either to land first.
- Change `dashboard/src/queries.ts`'s SQL beyond adding the columns it already needs. No JOINs, no new indexes.

## Implementation order

1. **`project-meta.ts` + tests.** Pure module first. Verify color resolution + cache + fallback in isolation.
2. **Wire into `queries.ts`.** Add the two new fields to ActivityEntry and InFlightEntry; populate via `resolveProjectMeta`. Typecheck passes.
3. **CSS in `shell.ts`.** Add `.project-chip` styles.
4. **Client rendering in `main.js`.** Replace inline projectLabel text with `<ProjectChip>` component. Manual page refresh to confirm.
5. **Visual check.** `forge dashboard start`, browser, eyeball every condition listed in manual verification.
6. **Commit + close #143.**

Each step is independently verifiable. If the .vscode color turns out to render too dark/light against the dashboard background, that's a Step 5 finding — fix with a brightness clamp in `project-meta.ts` rather than restructuring the spec.

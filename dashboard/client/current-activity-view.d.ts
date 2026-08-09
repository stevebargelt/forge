// FG-694: types for the Current-activity component (client/current-activity-view.js).
//
// Preact is a runtime dependency of the client, but the dashboard's TypeScript
// project only compiles src/ and browser-tests/ — the component is declared with a
// structural vnode type so a test can import and render it without pulling preact's
// JSX namespace into a project that has none.

import type { ActivityLoad } from "./current-activity-render.js";

export type CurrentActivityProps = {
  /** The load state — NOT a nullable payload. Null is not a state, and treating it
   *  as one is what let a failed read render as an observed absence (AC7). */
  load: ActivityLoad | null | undefined;
  now: number;
  onTaskClick?: ((taskId: string) => void) | undefined;
  onRetry?: (() => void) | undefined;
};

export function CurrentActivitySection(props: CurrentActivityProps): unknown;

export type InFlightActivityWaitsProps = {
  load: ActivityLoad | null | undefined;
  now: number;
  onRetry?: (() => void) | undefined;
};

/** The compact host-verification and required-check waits Home folds into its existing
 *  `In flight` section. Renders nothing when there is nothing to wait on. */
export function InFlightActivityWaits(props: InFlightActivityWaitsProps): unknown;

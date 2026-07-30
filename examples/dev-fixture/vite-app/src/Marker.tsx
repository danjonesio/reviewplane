/**
 * The HMR proof marker for RVP-14's end-to-end scenario.
 *
 * The scenario replaces MARKER_TEXT below with a `sed` edit made inside the
 * running container, then waits for the new text to appear in central
 * Chromium. This component is deliberately its own module, separate from
 * `App.tsx`: editing only this file lets React Fast Refresh swap this
 * component in place while leaving `App`'s click-counter state untouched,
 * which is the evidence that the update travelled as a hot module
 * replacement rather than a full page reload.
 *
 * It is a heading rather than a paragraph on purpose. The end-to-end scenario
 * records a before-and-after pair of accessibility snapshots as evidence, and
 * `apps/browser-worker/src/session/snapshot.ts` gives a role to `h1`-`h6` and
 * names them by their content; a paragraph is invisible to that snapshot, so
 * the proof would be unreadable in the evidence it produces.
 */
const MARKER_TEXT = "ALPHA";

export function Marker() {
  return <h2 data-testid="hmr-marker">HMR marker: {MARKER_TEXT}</h2>;
}

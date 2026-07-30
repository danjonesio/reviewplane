/**
 * Viewport handling, including the device pixel ratio.
 *
 * `AGENTS.md` "Browser-facing work" requires 390x844 and 1440x900 to be
 * exercised, and `docs/API.md` section 11 carries `device_scale_factor`
 * alongside the CSS dimensions. Annotation geometry is normalised against the
 * artefact content rectangle (`docs/DOMAIN_MODEL.md` section 16), so the
 * relationship between CSS pixels and captured pixels has to be computed
 * rather than assumed.
 */

import type { Viewport } from "@reviewplane/protocol/browser";

/** The presets every UI-facing change is tested at. */
export const VIEWPORT_PRESETS = {
  desktop: { width: 1440, height: 900, device_scale_factor: 1 },
  mobile: { width: 390, height: 844, device_scale_factor: 2 },
} as const satisfies Readonly<Record<string, Viewport>>;

export type ViewportPresetName = keyof typeof VIEWPORT_PRESETS;

/** Pixel dimensions of a capture taken at this viewport. */
export interface CaptureSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Device pixels a viewport-sized capture occupies. A fractional result would
 * make normalised annotation coordinates land between pixels, so the value is
 * rounded the way Chromium rounds it.
 */
export function captureSize(viewport: Viewport): CaptureSize {
  return {
    width: Math.round(viewport.width * viewport.device_scale_factor),
    height: Math.round(viewport.height * viewport.device_scale_factor),
  };
}

/** Whether two viewports describe the same rendering. */
export function sameViewport(left: Viewport, right: Viewport): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.device_scale_factor === right.device_scale_factor
  );
}

/** Playwright's context options for a viewport. */
export function playwrightViewport(viewport: Viewport): {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
} {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.device_scale_factor,
  };
}

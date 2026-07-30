/**
 * Project settings and their defaults (`docs/DOMAIN_MODEL.md` section 6,
 * `docs/UX_FLOWS.md` section 4).
 *
 * Stage 1 holds one setting: the viewports a project validates at. The defaults
 * are 390x844 and 1440x900 because `AGENTS.md` requires browser-facing work to
 * be tested at both, and a project that quietly defaulted to something else
 * would make the completion gate and the product disagree about what "checked"
 * means.
 *
 * The shape is defined in `schemas/platform/v1.schema.json` and validated by
 * the generated validator, so bounds are enforced by the same code in every
 * consumer. What lives here is the normalisation the schema cannot express: a
 * device pixel ratio of 1 is the default, so it is dropped rather than stored,
 * which makes `390x844` and `390x844 @1x` one value instead of two that the
 * uniqueness rule would let through side by side.
 */

import type { ProjectSettings, SchemaViolation, ValidationViewport } from "./generated/platform/v1/types.ts";
import { validateProjectSettings } from "./generated/platform/v1/validate.ts";

/** `AGENTS.md` "Browser-facing work": the two viewports everything is checked at. */
export const DEFAULT_VALIDATION_VIEWPORTS: readonly ValidationViewport[] = Object.freeze([
  Object.freeze({ width: 390, height: 844 }),
  Object.freeze({ width: 1440, height: 900 }),
]) as readonly ValidationViewport[];

/** The settings a project is created with when its creator names none. */
export function defaultProjectSettings(): ProjectSettings {
  return { default_validation_viewports: DEFAULT_VALIDATION_VIEWPORTS.map((viewport) => ({ ...viewport })) };
}

export type ProjectSettingsResult =
  | { readonly ok: true; readonly value: ProjectSettings }
  | { readonly ok: false; readonly violations: readonly SchemaViolation[] };

/**
 * Normalises and validates supplied settings.
 *
 * `undefined` yields the defaults; anything else is normalised and then checked
 * against the schema, so a caller cannot store a viewport a browser session
 * would later refuse to adopt.
 */
export function normaliseProjectSettings(input: unknown): ProjectSettingsResult {
  if (input === undefined || input === null) return { ok: true, value: defaultProjectSettings() };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, violations: [{ path: "settings", code: "type", message: "settings must be an object." }] };
  }

  const source = input as { default_validation_viewports?: unknown };
  const viewports =
    source.default_validation_viewports === undefined
      ? defaultProjectSettings().default_validation_viewports
      : source.default_validation_viewports;

  const normalised = Array.isArray(viewports)
    ? viewports.map((viewport) => normaliseViewport(viewport))
    : viewports;

  const candidate = { ...source, default_validation_viewports: normalised };
  const violations: SchemaViolation[] = [];
  validateProjectSettings(candidate, "settings", violations);
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: candidate as ProjectSettings };
}

/** Drops a device pixel ratio of 1, which is what "absent" already means. */
function normaliseViewport(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const viewport = value as { device_scale_factor?: unknown };
  if (viewport.device_scale_factor !== 1) return value;
  const { device_scale_factor: _dropped, ...rest } = viewport;
  return rest;
}

/** `390x844` for a log line, an error message or a form summary. */
export function formatViewport(viewport: ValidationViewport): string {
  const scale = viewport.device_scale_factor ?? 1;
  const base = `${String(viewport.width)}x${String(viewport.height)}`;
  return scale === 1 ? base : `${base}@${String(scale)}x`;
}

/**
 * What an artefact of each kind may contain, and how its bytes are served
 * (`docs/DOMAIN_MODEL.md` §20, `docs/SECURITY.md` §13, `docs/API.md` §15).
 *
 * The table below is the whole content-type policy, in one place, because
 * `docs/SECURITY.md` §13's "apply content-type and extension validation" is
 * only a real rule if there is one answer to "may this kind hold these bytes?"
 * rather than an answer per call site.
 *
 * Three properties are decided here.
 *
 * **A kind fixes its media types.** A DOM snapshot cannot be uploaded as a
 * screenshot, and a screenshot cannot be HTML. That is what stops the active
 * type reaching a code path built for images.
 *
 * **Active content is served as an attachment, always.** `text/html` is the one
 * type in the Stage 1 set that executes, and `docs/SECURITY.md` §13 forbids
 * rendering it under the control-plane origin. The disposition is a property of
 * the media type computed here, never a parameter a caller supplies, so there
 * is no request that can ask for it inline. `image/svg+xml` is not in the set
 * at all: no Stage 1 kind needs it, so an SVG is refused on upload rather than
 * stored and then held back at every reader.
 *
 * **Stage 2 kinds are refused with their own message.** `trace`, `har`,
 * `video`, `console_log` and `network_log` exist in the domain model and have
 * no capture behind them yet. Refusing them by name tells an operator that the
 * kind is not implemented, which is different from telling them it is unknown.
 */

/** Kinds this stage stores. `docs/DOMAIN_MODEL.md` §20's remainder is Stage 2. */
export const STAGE_1_ARTEFACT_KINDS = [
  "screenshot",
  "thumbnail",
  "dom_snapshot",
  "accessibility_snapshot",
  "review_export",
] as const;

export type Stage1ArtefactKind = (typeof STAGE_1_ARTEFACT_KINDS)[number];

/** Kinds the domain model names that no Stage 1 capture produces. */
export const DEFERRED_ARTEFACT_KINDS = [
  "trace",
  "har",
  "video",
  "console_log",
  "network_log",
] as const;

export type ArtefactDisposition = "inline" | "attachment";

interface KindPolicy {
  readonly contentTypes: readonly string[];
  readonly retentionClass: string;
  /** Whether a thumbnail is generated for a verified artefact of this kind. */
  readonly thumbnail: boolean;
}

const KIND_POLICY: Readonly<Record<Stage1ArtefactKind, KindPolicy>> = {
  screenshot: {
    contentTypes: ["image/png", "image/jpeg"],
    retentionClass: "action_screenshots",
    thumbnail: true,
  },
  // A thumbnail is derived, so it does not derive another; PNG only, because
  // the thumbnailer produces PNG.
  thumbnail: {
    contentTypes: ["image/png"],
    retentionClass: "action_screenshots",
    thumbnail: false,
  },
  dom_snapshot: {
    contentTypes: ["text/html"],
    retentionClass: "console_and_network_logs",
    thumbnail: false,
  },
  accessibility_snapshot: {
    contentTypes: ["application/json"],
    retentionClass: "console_and_network_logs",
    thumbnail: false,
  },
  review_export: {
    contentTypes: ["application/json", "text/plain"],
    retentionClass: "verification_evidence",
    thumbnail: false,
  },
};

/** Media types whose bytes execute if a browser is allowed to render them. */
const ACTIVE_CONTENT_TYPES: ReadonlySet<string> = new Set(["text/html", "image/svg+xml"]);

/** Media types this build can measure a content rectangle for. */
export const IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"]);

export function isStage1Kind(kind: string): kind is Stage1ArtefactKind {
  return (STAGE_1_ARTEFACT_KINDS as readonly string[]).includes(kind);
}

export function isDeferredKind(kind: string): boolean {
  return (DEFERRED_ARTEFACT_KINDS as readonly string[]).includes(kind);
}

/** Media types a kind accepts, or an empty list for a kind this stage refuses. */
export function contentTypesForKind(kind: string): readonly string[] {
  return isStage1Kind(kind) ? KIND_POLICY[kind].contentTypes : [];
}

/** Every media type any Stage 1 kind accepts. */
export function acceptedContentTypes(): readonly string[] {
  return [...new Set(STAGE_1_ARTEFACT_KINDS.flatMap((kind) => KIND_POLICY[kind].contentTypes))];
}

export function defaultRetentionClassForKind(kind: string): string {
  return isStage1Kind(kind) ? KIND_POLICY[kind].retentionClass : "action_screenshots";
}

export function kindWantsThumbnail(kind: string): boolean {
  return isStage1Kind(kind) && KIND_POLICY[kind].thumbnail;
}

export function isActiveContentType(contentType: string): boolean {
  return ACTIVE_CONTENT_TYPES.has(contentType);
}

/**
 * How the bytes of this media type are served.
 *
 * Derived, never chosen. `docs/SECURITY.md` §13: active markup is never
 * rendered under the control-plane origin, so it is downloaded instead.
 */
export function dispositionFor(contentType: string): ArtefactDisposition {
  return isActiveContentType(contentType) ? "attachment" : "inline";
}

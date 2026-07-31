/**
 * The safe artefact viewer (`docs/UX_FLOWS.md` §17): an original screenshot
 * with its annotations drawn over it, a before-and-after comparison, a download
 * where one is authorised, and the metadata a reader needs in order to trust
 * what they are looking at.
 *
 * Four decisions in here are requirements rather than taste.
 *
 * **The original stays available when the overlay does not.**
 * `docs/DEVELOPMENT.md` §11 and `docs/UX_FLOWS.md` §18 forbid a blank panel
 * where a specific cause exists. If the artefact has no measured content
 * rectangle, or the overlay throws, this component says so in words and keeps
 * showing the screenshot and the annotation list. Evidence that cannot be drawn
 * on is still evidence.
 *
 * **The bytes arrive through a short-lived grant.** There is no path that
 * serves an artefact from its identifier (ADR-0019), so the viewer mints a
 * grant and uses its URL. The grant is bound to this viewer session, which is
 * why putting it in an `img` attribute is safe, and it is refreshed on a timer
 * well inside its two-minute life rather than after a broken image.
 *
 * **Active content is never rendered here.** An artefact the server marks
 * `attachment` is markup a browser would execute (`docs/SECURITY.md` §13). This
 * component does not put it in an `img`, an `iframe` or an `object`: it offers
 * the download and says why. That is the same rule the server enforces with the
 * disposition header; the viewer states it rather than relying on it.
 *
 * **Every control is a real button or a real input.** The comparison is an
 * `input type="range"`, so it is operable with the arrow keys, Home and End
 * without a keyboard handler of this component's own, and the toggles are
 * buttons carrying `aria-pressed`. `docs/UX_FLOWS.md` §19's non-canvas
 * alternative — the annotation list — is always present below, and the overlay
 * is decorative in the accessibility tree because the list is the readable form
 * of the same marks.
 */

import { useQuery } from "@tanstack/react-query";
import {
  Component,
  useEffect,
  useId,
  useState,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from "react";

import { api, type Annotation, type Artefact, type ArtefactGrant } from "../api/client.ts";
import { AnnotationList } from "./AnnotationList.tsx";
import { AnnotationOverlay } from "./AnnotationOverlay.tsx";

/** Zoom levels of `docs/UX_FLOWS.md` §17. */
const ZOOMS = [
  { id: "fit", label: "Fit" },
  { id: "100", label: "100%" },
  { id: "200", label: "200%" },
] as const;

type Zoom = (typeof ZOOMS)[number]["id"];

export interface ArtefactViewerProps {
  readonly artefactId: string;
  readonly annotations: readonly Annotation[];
  /** Device pixel ratio the capture was taken at, from the finding. */
  readonly captureScale: number;
  readonly caption: string;
  /**
   * The artefact to compare against, where one exists — the "after" screenshot
   * of a verification submission (`docs/DOMAIN_MODEL.md` §19). Absent until an
   * agent has submitted one, and the viewer says so rather than showing a
   * comparison control that compares nothing.
   */
  readonly compareArtefactId?: string | null;
}

/**
 * Catches a failure inside the overlay so the evidence beneath it survives.
 *
 * A React error without a boundary unmounts the whole route, which would take
 * the screenshot and the annotation list with it — the opposite of what
 * `docs/UX_FLOWS.md` §18 asks for.
 */
class OverlayBoundary extends Component<
  { readonly children: ReactNode; readonly onFailure: (reason: string) => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onFailure(error.message);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** The artefact and a live grant for its bytes, loaded together. */
function useArtefact(artefactId: string | null | undefined): {
  readonly record: Artefact | undefined;
  readonly grant: ArtefactGrant | undefined;
  readonly pending: boolean;
  readonly failed: boolean;
} {
  const enabled = typeof artefactId === "string" && artefactId.length > 0;
  const record = useQuery({
    queryKey: ["artefact", artefactId],
    queryFn: () => api.artefact(artefactId as string),
    enabled,
  });
  const grant = useQuery({
    queryKey: ["artefact-grant", artefactId],
    queryFn: () => api.artefactGrant(artefactId as string),
    // A grant is short-lived by design, so it is refreshed well before it
    // expires rather than being retried after a broken image.
    refetchInterval: 90_000,
    staleTime: 60_000,
    enabled,
  });
  if (!enabled) return { record: undefined, grant: undefined, pending: false, failed: false };
  return {
    record: record.data,
    grant: grant.data,
    pending: record.isPending || grant.isPending,
    failed: record.isError || grant.isError,
  };
}

export function ArtefactViewer({
  artefactId,
  annotations,
  captureScale,
  caption,
  compareArtefactId = null,
}: ArtefactViewerProps): ReactElement {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [showOverlay, setShowOverlay] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const [overlayFailure, setOverlayFailure] = useState<string | null>(null);
  const [comparePercent, setComparePercent] = useState(50);
  const compareInputId = useId();

  const original = useArtefact(artefactId);
  const comparison = useArtefact(compareArtefactId);

  useEffect(() => {
    setOverlayFailure(null);
  }, [artefactId]);

  const record = original.record;
  const grant = original.grant;
  const content = record?.content_rectangle ?? null;

  if (original.pending) {
    return <p role="status">Loading the screenshot.</p>;
  }
  if (original.failed || record === undefined || grant === undefined) {
    return (
      <div role="alert" className="rounded border border-amber-500 bg-amber-50 p-4 dark:bg-amber-950">
        <h3 className="font-semibold">The screenshot could not be loaded</h3>
        <p className="mt-1 text-sm">
          The evidence is stored; this viewer could not reach it. The annotations below still
          describe what was marked.
        </p>
        <div className="mt-3">
          <AnnotationList
            annotations={annotations}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </div>
      </div>
    );
  }

  // Active markup is never put into an element that renders it. The server
  // serves it as an attachment; this says the same thing where a reader is.
  if (record.disposition === "attachment") {
    return (
      <div className="rounded border border-slate-300 p-4 dark:border-slate-700">
        <h3 className="font-semibold">This evidence is not displayed here</h3>
        <p className="mt-1 text-sm" data-testid="active-content-notice">
          A {describeKind(record.kind)} is a document that a browser would execute, so it is never
          rendered inside the application. Download it and open it somewhere isolated.
        </p>
        <a
          className="mt-3 inline-block rounded border border-slate-400 px-3 py-1 text-sm font-medium underline"
          href={grant.url}
          download={`${record.id}.html`}
          data-testid="artefact-download"
        >
          Download the {describeKind(record.kind)}
        </a>
        <ArtefactMetadata record={record} />
      </div>
    );
  }

  const naturalCssWidth = content === null ? 0 : content.width_px / Math.max(captureScale, 1);
  const naturalCssHeight = content === null ? 0 : content.height_px / Math.max(captureScale, 1);
  const stageStyle =
    zoom === "fit" || content === null
      ? undefined
      : {
          width: naturalCssWidth * (zoom === "200" ? 2 : 1),
          height: naturalCssHeight * (zoom === "200" ? 2 : 1),
        };

  const overlayUnavailable =
    content === null ? "This artefact has no measured content rectangle." : overlayFailure;
  const compareGrant = comparison.grant;
  const comparing = compareGrant !== undefined && comparison.record !== undefined;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Zoom" className="flex gap-2">
          {ZOOMS.map((level) => (
            <button
              key={level.id}
              type="button"
              data-zoom={level.id}
              onClick={() => {
                setZoom(level.id);
              }}
              aria-pressed={zoom === level.id}
              className={`rounded border px-3 py-1 text-sm font-medium ${
                zoom === level.id ? "border-sky-600 bg-sky-50 dark:bg-sky-950" : "border-slate-400"
              }`}
            >
              {level.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="toggle-annotations"
            onClick={() => {
              setShowOverlay((previous) => !previous);
            }}
            aria-pressed={showOverlay}
            className="rounded border border-slate-400 px-3 py-1 text-sm font-medium"
          >
            {showOverlay ? "Hide annotations" : "Show annotations"}
          </button>
          {/*
            The download is offered whenever the session could mint a grant for
            these bytes, which is exactly the authorisation the bytes themselves
            need: `docs/UX_FLOWS.md` section 17's "download when authorised" is
            the grant, not a second permission.
          */}
          <a
            href={grant.url}
            download={`${record.id}${extensionFor(record.content_type)}`}
            data-testid="artefact-download"
            className="rounded border border-slate-400 px-3 py-1 text-sm font-medium underline"
          >
            Download
          </a>
        </div>
      </div>

      {overlayUnavailable === null ? null : (
        <p
          role="status"
          data-testid="overlay-degraded"
          className="mt-3 rounded border border-amber-500 bg-amber-50 px-3 py-2 text-sm dark:bg-amber-950"
        >
          Annotations cannot be drawn over this screenshot: {overlayUnavailable} The original and
          the annotation list below are unaffected.
        </p>
      )}

      <div
        data-testid="artefact-panel"
        className="mt-3 max-h-[60vh] overflow-auto rounded border border-slate-300 bg-slate-950 dark:border-slate-700"
      >
        <div
          ref={setStage}
          data-testid="artefact-stage"
          className="relative mx-auto"
          style={stageStyle ?? { width: "100%", height: "60vh" }}
        >
          <img
            data-testid="artefact-image"
            src={grant.url}
            alt={caption}
            draggable={false}
            className="block h-full w-full object-contain"
          />
          {comparing ? (
            // The after screenshot is clipped to the slider's position, so the
            // two pictures share one box and one content rectangle and the
            // overlay above keeps meaning what it meant.
            <img
              data-testid="artefact-compare-image"
              src={compareGrant.url}
              alt={`After: ${caption}`}
              draggable={false}
              className="absolute inset-0 block h-full w-full object-contain"
              style={{ clipPath: `inset(0 0 0 ${String(comparePercent)}%)` }}
            />
          ) : null}
          {comparing ? (
            <div
              aria-hidden="true"
              data-testid="artefact-compare-handle"
              className="pointer-events-none absolute inset-y-0 w-0.5 bg-sky-400"
              style={{ left: `${String(comparePercent)}%` }}
            />
          ) : null}
          {showOverlay && content !== null && overlayFailure === null ? (
            <OverlayBoundary onFailure={setOverlayFailure}>
              <AnnotationOverlay
                annotations={annotations}
                content={content}
                stage={stage}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </OverlayBoundary>
          ) : null}
        </div>
      </div>

      <div className="mt-3" data-testid="artefact-compare">
        {comparing ? (
          <>
            <label htmlFor={compareInputId} className="block text-sm font-medium">
              Before and after
            </label>
            <input
              id={compareInputId}
              data-testid="artefact-compare-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={comparePercent}
              onChange={(event) => {
                setComparePercent(Number(event.target.value));
              }}
              aria-valuetext={`${String(comparePercent)} per cent before, ${String(
                100 - comparePercent,
              )} per cent after`}
              className="mt-1 w-full"
            />
            <p className="mt-1 text-xs text-slate-700 dark:text-slate-300">
              The left of the handle is the screenshot the finding was raised on; the right is the
              evidence submitted with the fix. Use the arrow keys, Home or End.
            </p>
          </>
        ) : (
          <p className="text-xs text-slate-700 dark:text-slate-300" data-testid="artefact-compare-empty">
            No after screenshot has been submitted for this finding yet, so there is nothing to
            compare the original against.
          </p>
        )}
      </div>

      <ArtefactMetadata record={record} />

      <h3 className="mt-5 text-sm font-semibold">Annotations</h3>
      <p className="mt-1 text-xs text-slate-700 dark:text-slate-300">
        The same marks as text, for reading without the canvas.
      </p>
      <div className="mt-2">
        <AnnotationList annotations={annotations} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
    </div>
  );
}

/**
 * What `docs/UX_FLOWS.md` §17 calls "metadata and hash, redaction state and
 * retention expiry".
 *
 * The retention line says when retention becomes *due*, because Stage 1 records
 * the date and runs no deletion. Saying "expires" would promise something the
 * product does not do.
 */
function ArtefactMetadata({ record }: { readonly record: Artefact }): ReactElement {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
      <div>
        <dt className="text-slate-600 dark:text-slate-400">Content rectangle</dt>
        <dd data-testid="content-rectangle" className="font-mono">
          {record.content_rectangle === null
            ? "not measured"
            : `${String(record.content_rectangle.width_px)}x${String(
                record.content_rectangle.height_px,
              )} px`}
        </dd>
      </div>
      <div className="col-span-2 min-w-0">
        <dt className="text-slate-600 dark:text-slate-400">SHA-256</dt>
        <dd className="truncate font-mono" data-testid="artefact-sha256">
          {record.sha256 ?? "not verified"}
        </dd>
      </div>
      <div>
        <dt className="text-slate-600 dark:text-slate-400">Redaction</dt>
        <dd className="font-mono" data-testid="artefact-redaction">
          {record.redaction_state === "not_applied" ? "none applied" : record.redaction_state}
        </dd>
      </div>
      <div>
        <dt className="text-slate-600 dark:text-slate-400">Size</dt>
        <dd className="font-mono">
          {record.size_bytes === null ? "not verified" : `${String(record.size_bytes)} bytes`}
        </dd>
      </div>
      <div className="col-span-2">
        <dt className="text-slate-600 dark:text-slate-400">Retention</dt>
        <dd className="font-mono" data-testid="artefact-retention">
          {record.expires_at === null
            ? `${record.retention_class}, no expiry set`
            : `${record.retention_class}, due ${new Date(record.expires_at).toISOString().slice(0, 10)}`}
        </dd>
      </div>
    </dl>
  );
}

function extensionFor(contentType: string): string {
  if (contentType === "image/png") return ".png";
  if (contentType === "image/jpeg") return ".jpg";
  if (contentType === "application/json") return ".json";
  if (contentType === "text/html") return ".html";
  return "";
}

function describeKind(kind: string): string {
  return kind === "dom_snapshot" ? "DOM snapshot" : kind.replace(/_/gu, " ");
}

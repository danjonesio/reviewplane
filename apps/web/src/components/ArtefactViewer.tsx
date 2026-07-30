/**
 * The artefact viewer (`docs/UX_FLOWS.md` section 17): an original screenshot
 * with its annotations drawn over it, at a chosen zoom, plus the metadata and
 * hash a reader needs in order to trust what they are looking at.
 *
 * Two decisions in here are requirements rather than taste.
 *
 * **The original stays available when the overlay does not.**
 * `docs/DEVELOPMENT.md` section 11 and `docs/UX_FLOWS.md` section 18 forbid a
 * blank panel where a specific cause exists. If the artefact has no measured
 * content rectangle, or the overlay throws, this component says so in words
 * and keeps showing the screenshot and the annotation list. Evidence that
 * cannot be drawn on is still evidence.
 *
 * **The bytes arrive through a short-lived grant.** There is no path that
 * serves an artefact from its identifier (ADR-0019), so the viewer mints a
 * grant and uses its URL. The grant is bound to this viewer session, which is
 * why putting it in an `img` attribute is safe.
 */

import { useQuery } from "@tanstack/react-query";
import {
  Component,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from "react";

import { api, type Annotation, type Artefact } from "../api/client.ts";
import { AnnotationList } from "./AnnotationList.tsx";
import { AnnotationOverlay } from "./AnnotationOverlay.tsx";

/** Zoom levels of `docs/UX_FLOWS.md` section 17. */
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
}

/**
 * Catches a failure inside the overlay so the evidence beneath it survives.
 *
 * A React error without a boundary unmounts the whole route, which would take
 * the screenshot and the annotation list with it — the opposite of what
 * `docs/UX_FLOWS.md` section 18 asks for.
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

export function ArtefactViewer({
  artefactId,
  annotations,
  captureScale,
  caption,
}: ArtefactViewerProps): ReactElement {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [showOverlay, setShowOverlay] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stage, setStage] = useState<HTMLElement | null>(null);
  const [overlayFailure, setOverlayFailure] = useState<string | null>(null);

  const artefact = useQuery({
    queryKey: ["artefact", artefactId],
    queryFn: () => api.artefact(artefactId),
  });
  const grant = useQuery({
    queryKey: ["artefact-grant", artefactId],
    queryFn: () => api.artefactGrant(artefactId),
    // A grant is short-lived by design, so it is refreshed well before it
    // expires rather than being retried after a broken image.
    refetchInterval: 90_000,
    staleTime: 60_000,
  });

  useEffect(() => {
    setOverlayFailure(null);
  }, [artefactId]);

  const record: Artefact | undefined = artefact.data;
  const content = record?.content_rectangle ?? null;

  if (artefact.isPending || grant.isPending) {
    return <p role="status">Loading the screenshot.</p>;
  }
  if (artefact.isError || grant.isError || record === undefined || grant.data === undefined) {
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

  const naturalCssWidth = content === null ? 0 : content.width_px / Math.max(captureScale, 1);
  const naturalCssHeight = content === null ? 0 : content.height_px / Math.max(captureScale, 1);
  const stageStyle =
    zoom === "fit" || content === null
      ? undefined
      : {
          width: naturalCssWidth * (zoom === "200" ? 2 : 1),
          height: naturalCssHeight * (zoom === "200" ? 2 : 1),
        };

  const overlayUnavailable = content === null ? "This artefact has no measured content rectangle." : overlayFailure;

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
                zoom === level.id
                  ? "border-sky-600 bg-sky-50 dark:bg-sky-950"
                  : "border-slate-400"
              }`}
            >
              {level.label}
            </button>
          ))}
        </div>
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
            src={grant.data.url}
            alt={caption}
            draggable={false}
            className="block h-full w-full object-contain"
          />
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

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Content rectangle</dt>
          <dd data-testid="content-rectangle" className="font-mono">
            {content === null
              ? "not measured"
              : `${String(content.width_px)}x${String(content.height_px)} px`}
          </dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-slate-600 dark:text-slate-400">SHA-256</dt>
          <dd className="truncate font-mono">{record.sha256 ?? "not verified"}</dd>
        </div>
        <div>
          <dt className="text-slate-600 dark:text-slate-400">Redaction</dt>
          <dd className="font-mono">{record.redaction_state}</dd>
        </div>
      </dl>

      <h3 className="mt-5 text-sm font-semibold">Annotations</h3>
      <p className="mt-1 text-xs text-slate-700 dark:text-slate-300">
        The same marks as text, for reading without the canvas.
      </p>
      <div className="mt-2">
        <AnnotationList
          annotations={annotations}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
    </div>
  );
}

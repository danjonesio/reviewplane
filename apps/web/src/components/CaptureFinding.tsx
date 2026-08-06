/**
 * Annotated finding capture and named review creation
 * (`docs/UX_FLOWS.md` sections 9 and 10, `docs/PROJECT.md` section 7).
 *
 * This is the product's first killer capability, end to end: capture the frame
 * a human is watching, draw over it, describe what is wrong, group the drafts
 * into a review with a durable name, and hand that name to an agent.
 *
 * **Draft findings live in the browser until the review is named.** A finding
 * belongs to a review (`docs/DOMAIN_MODEL.md` section 15), and section 10 of
 * the flows groups drafts into one — so there is no review to attach the first
 * draft to until the human has named it. Holding drafts here rather than
 * inventing a server-side draft review keeps the domain model as it is, and
 * the surface says plainly that nothing is saved yet rather than implying it.
 * They are mirrored into `sessionStorage`, so a reload recovers them instead of
 * losing an afternoon's annotation; `docs/TESTING.md` section 11 requires a
 * draft to be recoverable or clearly discarded and never partially saved, and
 * a draft that only exists in this tab is one or the other by construction.
 *
 * **The evidence is captured before the mark is drawn, and never after.** The
 * screenshot and the accessibility snapshot are taken in the same moment, so
 * the elements the snapshot describes are the elements in the picture. A
 * capture whose upload did not complete is not evidence, and the flow says
 * "Evidence upload incomplete" rather than letting a finding be built on it.
 *
 * **Nothing here injects anything into an agent's terminal**, and the surface
 * says so: the CLI command is offered to be copied and run by a person.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import {
  describeGeometry,
  resolveElementContext,
  type AnnotationGeometry,
  type AnnotationType,
} from "@reviewplane/protocol/review";

import {
  ApiFailure,
  api,
  type BrowserSession,
  type ElementContext,
  type FindingSeverity,
  type ReviewPriority,
  type SnapshotElement,
  type WorkspaceSummary,
} from "../api/client.ts";
import { AnnotationCanvas, type DraftAnnotation } from "./AnnotationCanvas.tsx";
import { AnnotationList } from "./AnnotationList.tsx";
import { RefusalPanel, SHARED_REFUSALS, type RefusalTable } from "./refusals.tsx";

const FIELD =
  "rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900";
const HINT = "text-xs text-slate-600 dark:text-slate-400";
const CARD = "rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900";
const PRIMARY =
  "self-start rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60";
const CONTROL =
  "rounded border border-slate-400 px-3 py-2 text-sm font-medium disabled:opacity-60 dark:border-slate-600";

const SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium", "low", "suggestion"];
const PRIORITIES: readonly ReviewPriority[] = ["critical", "high", "medium", "low"];

/**
 * What the capture flow can be refused with, and what to do about it
 * (`docs/UX_FLOWS.md` section 18).
 *
 * Every entry names a cause and an action. "Evidence upload incomplete" is the
 * one section 18 lists by name, and it is the one that matters most here: a
 * finding built on unverified bytes would look complete and be worthless.
 */
const CAPTURE_REFUSALS: RefusalTable = {
  ...SHARED_REFUSALS,
  ARTEFACT_UPLOAD_INCOMPLETE: {
    title: "Evidence upload incomplete",
    action:
      "The screenshot was captured but its bytes were not verified, so it is not evidence yet and no finding was created on it. Capture again; if it keeps happening, the browser worker cannot reach the artefact store.",
  },
  IDEMPOTENCY_CONFLICT: {
    title: "That name is already in use",
    action:
      "Another active review of this project already has this slug, and an agent told to work on it must never face two candidates. Choose a different slug, or archive the review that holds this one.",
  },
  BROWSER_SESSION_NOT_ACTIVE: {
    title: "This browser session is not running",
    action:
      "A capture needs a live session. Start a new one; the drafts already held in this tab are unaffected.",
  },
  CONTROL_EPOCH_STALE: {
    title: "Somebody else took control of this browser",
    action:
      "The control epoch this page held has been superseded, so the capture was refused rather than executed. Reload the session and capture again.",
  },
  VALIDATION_FAILED: {
    title: "The control plane refused this review",
    action: "The message below says which value it refused. Nothing was created.",
  },
  UNSUPPORTED_CAPABILITY: {
    title: "The control plane refused this value",
    action:
      "A geometry outside the artefact's content rectangle, or a field the schema does not carry. Nothing was created.",
  },
};

/** One capture: the picture, its measurements and the page it was taken from. */
interface Capture {
  readonly artefactId: string;
  readonly contentRectangle: { readonly width_px: number; readonly height_px: number };
  readonly viewport: { width: number; height: number; device_scale_factor: number };
  readonly scroll: { x: number; y: number };
  readonly url: string;
  readonly capturedAt: string;
  /** Page-derived, and used only as candidates for element resolution. */
  readonly elements: readonly SnapshotElement[];
  readonly snapshotTruncated: boolean;
}

/** A finding a human has described and not yet saved. */
interface DraftFinding {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly severity: FindingSeverity;
  readonly acceptanceCriteria: string;
  readonly capture: Capture;
  readonly annotations: readonly DraftAnnotation[];
  readonly elementContext: ElementContext | null;
}

function draftKey(sessionId: string): string {
  return `reviewplane.capture-drafts.${sessionId}`;
}

/** A slug preview. The server decides; this only shows what will be sent. */
export function previewSlug(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63);
}

/**
 * The command a human runs in their agent's terminal
 * (`docs/UX_FLOWS.md` section 10).
 *
 * The wording is the documented one, and the double quotes are part of it: the
 * agent resolves a review by name inside its own project.
 */
export function cliCommand(slug: string): string {
  return `Review and resolve control-plane review "${slug}".`;
}

function newDraftId(): string {
  return `draft_${Math.random().toString(36).slice(2, 12)}`;
}

export interface CaptureFindingProps {
  readonly session: BrowserSession;
  readonly workspace: WorkspaceSummary | null;
  /** The page the live view is showing, as text. Never a link. */
  readonly currentUrl: string | null;
}

export function CaptureFinding({
  session,
  workspace,
  currentUrl,
}: CaptureFindingProps): ReactElement {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [annotations, setAnnotations] = useState<readonly DraftAnnotation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<readonly DraftFinding[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<FindingSeverity>("high");
  const [acceptance, setAcceptance] = useState("");
  const [recovered, setRecovered] = useState(false);

  // Drafts are recovered on mount and mirrored on every change. Losing an
  // afternoon of annotation to a reload is the failure this prevents; the
  // alternative the tests require is that they are clearly discarded, and a
  // silent loss is neither.
  useEffect(() => {
    try {
      const stored = globalThis.sessionStorage.getItem(draftKey(session.id));
      if (stored === null) return;
      const parsed = JSON.parse(stored) as DraftFinding[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        setDrafts(parsed);
        setRecovered(true);
      }
    } catch {
      // A storage a browser refuses is not a failure of the flow: the drafts
      // simply do not survive a reload, and the notice below says so.
    }
  }, [session.id]);

  useEffect(() => {
    try {
      globalThis.sessionStorage.setItem(draftKey(session.id), JSON.stringify(drafts));
    } catch {
      // As above.
    }
  }, [drafts, session.id]);

  const grant = useQuery({
    queryKey: ["capture-grant", capture?.artefactId],
    queryFn: () => api.artefactGrant(capture?.artefactId ?? ""),
    enabled: capture !== null,
    refetchInterval: 90_000,
    staleTime: 60_000,
  });

  const takeCapture = useMutation({
    mutationFn: async (): Promise<Capture> => {
      const epoch = session.control_epoch ?? 0;
      const shot = await api.captureScreenshot(session.id, epoch);
      if (!shot.ok || shot.screenshot === undefined) {
        throw new ApiFailure(
          502,
          shot.error?.code ?? "ARTEFACT_UPLOAD_INCOMPLETE",
          shot.error?.message ??
            "The browser worker did not return a screenshot, so there is no evidence to annotate.",
        );
      }
      // The artefact must be *available* before a finding may name it. The
      // control plane refuses an incomplete one, and a draft built on it would
      // be a finding with no evidence that looked complete until it was saved.
      const artefact = await api.artefact(shot.screenshot.artefact_id);
      if (artefact.state !== "available" || artefact.content_rectangle === null) {
        throw new ApiFailure(
          409,
          "ARTEFACT_UPLOAD_INCOMPLETE",
          "Evidence upload incomplete: the screenshot was captured but its bytes were not verified, so it cannot be annotated yet.",
        );
      }
      // Best effort: a snapshot that fails costs the element context and
      // nothing else, and `docs/UX_FLOWS.md` section 9 calls that context
      // best effort. A capture refused because the page would not describe
      // itself would be the page deciding whether a finding may be raised.
      let elements: readonly SnapshotElement[] = [];
      let truncated = false;
      try {
        const snapshot = await api.captureSnapshot(session.id, epoch);
        elements = snapshot.snapshot?.elements ?? [];
        truncated = snapshot.snapshot?.truncated ?? false;
      } catch {
        elements = [];
      }
      return {
        artefactId: shot.screenshot.artefact_id,
        contentRectangle: artefact.content_rectangle,
        viewport: shot.screenshot.viewport,
        // Measured by the worker at the moment of capture, never assumed. A
        // viewport capture is a picture of one screenful, and this is the only
        // value that says which screenful: element boxes arrive in document
        // coordinates, and a mark on a page scrolled 800 pixels resolves
        // against the top of the document without it — a well-formed answer
        // about the wrong element (ADR-0033).
        scroll: shot.screenshot.scroll_position,
        url: currentUrl ?? session.service_origin ?? "about:blank",
        capturedAt: shot.screenshot.captured_at,
        elements,
        snapshotTruncated: truncated,
      };
    },
    onSuccess: (value) => {
      setCapture(value);
      setAnnotations([]);
      setFailure(null);
      setAnnouncement(
        `Captured a screenshot at ${String(value.viewport.width)} by ${String(
          value.viewport.height,
        )} CSS pixels. Draw over it to mark what is wrong.`,
      );
    },
    onError: (error) => {
      setFailure(error instanceof ApiFailure ? error : null);
      setAnnouncement("The capture did not complete.");
    },
  });

  const addAnnotation = useCallback(
    ({ type, geometry }: { type: AnnotationType; geometry: AnnotationGeometry }) => {
      setAnnotations((previous) => {
        const markerNumber =
          previous.filter((mark) => mark.type === "numbered_marker").length + 1;
        const draft: DraftAnnotation = {
          id: newDraftId(),
          type,
          geometry,
          // Every mark carries a text alternative from the moment it exists,
          // because the annotation list is an equal alternative to the canvas
          // rather than a fallback (`docs/UX_FLOWS.md` section 19).
          label: `${type.replace("_", " ")} ${String(previous.length + 1)}`,
          ...(type === "numbered_marker" ? { marker_number: markerNumber } : {}),
        };
        return [...previous, draft];
      });
    },
    [],
  );

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations((previous) => previous.filter((mark) => mark.id !== id));
    setAnnouncement("Removed a mark that was never recorded.");
  }, []);

  /**
   * The element under the first mark, resolved from the snapshot taken with
   * the picture. `null` is a normal outcome: a mark over whitespace has no
   * element under it, and the finding is stored without one rather than with
   * an invented one.
   */
  const elementContext = useMemo((): ElementContext | null => {
    const first = annotations[0];
    if (first === undefined || capture === null) return null;
    return resolveElementContext(
      first.type,
      first.geometry,
      capture.viewport,
      capture.scroll,
      capture.elements,
    );
  }, [annotations, capture]);

  const saveDraft = (): void => {
    if (capture === null || title.trim() === "" || annotations.length === 0) return;
    setDrafts((previous) => [
      ...previous,
      {
        id: newDraftId(),
        title: title.trim(),
        description: description.trim(),
        severity,
        acceptanceCriteria: acceptance.trim(),
        capture,
        annotations,
        elementContext,
      },
    ]);
    setAnnouncement(
      `Draft finding "${title.trim()}" held with ${String(
        annotations.length,
      )} mark${annotations.length === 1 ? "" : "s"}. It is not saved until you name a review.`,
    );
    setTitle("");
    setDescription("");
    setAcceptance("");
    setSeverity("high");
    setAnnotations([]);
    setCapture(null);
  };

  const removeDraft = (id: string): void => {
    setDrafts((previous) => previous.filter((draft) => draft.id !== id));
    setAnnouncement("Discarded a draft finding. Nothing was ever saved for it.");
  };

  return (
    <section
      id="capture"
      aria-labelledby="capture-heading"
      data-testid="capture-panel"
      className="rounded border border-slate-300 p-3 dark:border-slate-700"
    >
      <h2 id="capture-heading" className="text-sm font-semibold">
        Annotate this session and create a review
      </h2>
      <p className={`mt-1 ${HINT}`}>
        A capture records the picture, the page, the viewport, the device-pixel ratio and the
        commit it was taken from, so an agent can reproduce what you saw. Drawing here never sends
        a pointer or a keystroke to the page.
      </p>

      <p role="status" aria-live="polite" data-testid="capture-activity" className={`mt-2 ${HINT}`}>
        {announcement}
      </p>
      {failure === null ? null : (
        <RefusalPanel
          code={failure.code}
          message={failure.message}
          attribute="data-failure"
          table={CAPTURE_REFUSALS}
          surface="capture"
        />
      )}

      {capture === null ? (
        <button
          type="button"
          id="capture-screenshot"
          className={`${PRIMARY} mt-3`}
          disabled={takeCapture.isPending}
          onClick={() => {
            takeCapture.mutate();
          }}
        >
          {takeCapture.isPending ? "Capturing…" : "Capture a screenshot to annotate"}
        </button>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          <AnnotationCanvas
            content={capture.contentRectangle}
            annotations={annotations}
            onAdd={addAnnotation}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAnnounce={setAnnouncement}
          >
            {grant.data === undefined ? (
              <div
                data-testid="capture-image-pending"
                className="flex h-64 items-center justify-center text-sm text-slate-300"
              >
                Loading the captured screenshot…
              </div>
            ) : (
              <img
                data-testid="capture-image"
                src={grant.data.url}
                alt={`Screenshot captured from ${capture.url} at ${String(
                  capture.viewport.width,
                )} by ${String(capture.viewport.height)} CSS pixels.`}
                draggable={false}
                className="block h-auto w-full"
              />
            )}
          </AnnotationCanvas>

          <div>
            <h3 className="text-sm font-semibold">Marks on this capture</h3>
            <p className={HINT}>
              The same information as the drawing, as text. Every mark is listed here whether or
              not the overlay can be drawn.
            </p>
            <div className="mt-2">
              <AnnotationList
                annotations={annotations}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onRemove={removeAnnotation}
                testId="capture-annotation-list"
                emptyMessage="No marks yet. Choose a tool and draw over the capture, or focus the canvas and use the arrow keys and Enter."
              />
            </div>
          </div>

          <CapturedContext capture={capture} workspace={workspace} elementContext={elementContext} />

          <form
            className="flex flex-col gap-4"
            data-testid="draft-finding-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveDraft();
            }}
          >
            <div className="flex flex-col gap-2">
              <label htmlFor="finding-title" className="text-sm font-medium">
                Title
              </label>
              <input
                id="finding-title"
                name="finding-title"
                value={title}
                required
                onChange={(event) => {
                  setTitle(event.target.value);
                }}
                className={`${FIELD} w-full`}
                aria-describedby="finding-title-hint"
              />
              <p id="finding-title-hint" className={HINT}>
                What is wrong, in the words an agent will read first.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="finding-comment" className="text-sm font-medium">
                Comment
              </label>
              <textarea
                id="finding-comment"
                name="finding-comment"
                rows={3}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
                className={`${FIELD} w-full`}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="finding-severity" className="text-sm font-medium">
                Severity
              </label>
              <select
                id="finding-severity"
                name="finding-severity"
                value={severity}
                onChange={(event) => {
                  setSeverity(event.target.value as FindingSeverity);
                }}
                className={`${FIELD} w-full sm:max-w-xs`}
              >
                {SEVERITIES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="finding-acceptance" className="text-sm font-medium">
                Acceptance criteria (optional)
              </label>
              <textarea
                id="finding-acceptance"
                name="finding-acceptance"
                rows={2}
                value={acceptance}
                onChange={(event) => {
                  setAcceptance(event.target.value);
                }}
                className={`${FIELD} w-full`}
                aria-describedby="finding-acceptance-hint"
              />
              <p id="finding-acceptance-hint" className={HINT}>
                What a resolution has to demonstrate before you would accept it.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                id="save-draft-finding"
                className={PRIMARY}
                disabled={title.trim() === "" || annotations.length === 0}
              >
                Save as draft finding
              </button>
              <button
                type="button"
                id="discard-capture"
                className={CONTROL}
                onClick={() => {
                  setCapture(null);
                  setAnnotations([]);
                  setAnnouncement("Discarded the capture. Nothing was saved.");
                }}
              >
                Discard this capture
              </button>
            </div>
            {annotations.length === 0 ? (
              <p className={HINT}>
                A finding needs at least one mark: it is what turns a description into a place on
                the screen.
              </p>
            ) : null}
          </form>
        </div>
      )}

      <DraftFindings
        drafts={drafts}
        recovered={recovered}
        onRemove={removeDraft}
        session={session}
        workspace={workspace}
        onDone={() => {
          setDrafts([]);
          setRecovered(false);
        }}
        onAnnounce={setAnnouncement}
      />
    </section>
  );
}

/** The captured context, stated rather than implied (`UX_FLOWS.md` §9). */
function CapturedContext({
  capture,
  workspace,
  elementContext,
}: {
  readonly capture: Capture;
  readonly workspace: WorkspaceSummary | null;
  readonly elementContext: ElementContext | null;
}): ReactElement {
  return (
    <div data-testid="captured-context">
      <h3 className="text-sm font-semibold">Captured context</h3>
      <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {/* Page-derived, so it is text and never a link the page controls. */}
        <dt className="text-slate-600 dark:text-slate-400">URL</dt>
        <dd data-testid="captured-url" className="break-all">
          {capture.url}
        </dd>
        <dt className="text-slate-600 dark:text-slate-400">Viewport</dt>
        <dd data-testid="captured-viewport">
          {capture.viewport.width} x {capture.viewport.height} @{" "}
          {capture.viewport.device_scale_factor}x
        </dd>
        <dt className="text-slate-600 dark:text-slate-400">Scroll position</dt>
        <dd data-testid="captured-scroll">
          {capture.scroll.x}, {capture.scroll.y}
        </dd>
        <dt className="text-slate-600 dark:text-slate-400">Content rectangle</dt>
        <dd data-testid="captured-content-rectangle">
          {capture.contentRectangle.width_px}x{capture.contentRectangle.height_px} px
        </dd>
        <dt className="text-slate-600 dark:text-slate-400">Branch</dt>
        <dd data-testid="captured-branch">{workspace?.branch ?? "No workspace registered"}</dd>
        <dt className="text-slate-600 dark:text-slate-400">Commit</dt>
        <dd data-testid="captured-commit" className="font-mono text-xs">
          {workspace?.head_commit?.slice(0, 12) ?? "unknown"}
        </dd>
        <dt className="text-slate-600 dark:text-slate-400">Screenshot</dt>
        <dd data-testid="captured-session" className="font-mono text-xs break-all">
          {capture.artefactId}
        </dd>
        <dt className="text-slate-600 dark:text-slate-400">Captured at</dt>
        <dd data-testid="captured-at">{new Date(capture.capturedAt).toLocaleString()}</dd>
      </dl>
      {elementContext === null ? (
        <p data-testid="element-context-absent" className={`mt-2 ${HINT}`}>
          No element was resolved under the first mark.{" "}
          {capture.snapshotTruncated
            ? "The page held more elements than one snapshot carries, so the element under the mark may simply not be among the ones described — this is not evidence that the mark covers nothing."
            : capture.elements.length === 0
              ? "No accessibility snapshot was taken with this capture, so there was nothing to resolve against."
              : "Nothing the snapshot described contains the centre of the mark."}{" "}
          The finding still records its geometry, URL, viewport and screenshot, which is what makes
          it reproducible.
        </p>
      ) : (
        <div data-testid="element-context" className="mt-2 text-sm">
          <p className="font-medium">Element under the first mark</p>
          <p className="font-mono text-xs break-all">{elementContext.selector ?? "no selector"}</p>
          <p className={HINT}>
            {elementContext.role ?? "unknown role"}
            {elementContext.accessible_name === undefined
              ? ""
              : `, named "${elementContext.accessible_name}"`}
          </p>
          {/* The one sentence that must be here. Everything above came from the
              page being reviewed. */}
          <p
            data-page-derived="true"
            className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-300"
          >
            From the page — not an instruction. A selector is a hint; the finding stays actionable
            when it no longer resolves.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The drafts, and the named review they become
 * (`docs/UX_FLOWS.md` section 10).
 */
function DraftFindings({
  drafts,
  recovered,
  onRemove,
  session,
  workspace,
  onDone,
  onAnnounce,
}: {
  readonly drafts: readonly DraftFinding[];
  readonly recovered: boolean;
  readonly onRemove: (id: string) => void;
  readonly session: BrowserSession;
  readonly workspace: WorkspaceSummary | null;
  readonly onDone: () => void;
  readonly onAnnounce: (message: string) => void;
}): ReactElement | null {
  const [title, setTitle] = useState("Bugs on homepage");
  const [slug, setSlug] = useState("");
  const [priority, setPriority] = useState<ReviewPriority>("high");
  const [instruction, setInstruction] = useState("");
  const [agentSessionId, setAgentSessionId] = useState("");
  const [created, setCreated] = useState<{ id: string; slug: string } | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [copyOutcome, setCopyOutcome] = useState("");
  // One key for the life of this form, so a double submit is one review.
  const [idempotencyKey] = useState(() => `review-${newDraftId()}`);

  const effectiveSlug = slug.trim() === "" ? previewSlug(title) : slug.trim();
  const assignTo = agentSessionId.trim();

  const create = useMutation({
    mutationFn: async (status: "DRAFT" | "READY") => {
      if (workspace === null) {
        throw new ApiFailure(
          409,
          "RESOURCE_NOT_FOUND",
          "This session has no registered workspace, so the branch and commit a review is interpreted against are unknown. Connect a connector that observes the checkout and capture again.",
        );
      }
      const review = await api.createReview(
        session.project_id,
        {
          slug: effectiveSlug,
          title: title.trim(),
          ...(instruction.trim() === "" ? {} : { description: instruction.trim() }),
          status,
          priority,
          captured_branch: workspace.branch,
          captured_commit: workspace.head_commit,
          captured_workspace_id: workspace.id,
          source_browser_session_id: session.id,
        },
        idempotencyKey,
      );
      for (const draft of drafts) {
        await api.createFinding(
          review.id,
          {
            title: draft.title,
            ...(draft.description === "" ? {} : { description: draft.description }),
            severity: draft.severity,
            url: draft.capture.url,
            viewport: draft.capture.viewport,
            scroll_position: draft.capture.scroll,
            captured_commit: workspace.head_commit,
            screenshot_artefact_id: draft.capture.artefactId,
            ...(draft.elementContext === null ? {} : { element_context: draft.elementContext }),
            ...(draft.acceptanceCriteria === ""
              ? {}
              : { acceptance_criteria: draft.acceptanceCriteria }),
            annotations: draft.annotations.map((mark) => ({
              artefact_id: draft.capture.artefactId,
              type: mark.type,
              geometry: mark.geometry,
              label: mark.label,
              ...(mark.marker_number === undefined ? {} : { marker_number: mark.marker_number }),
            })),
          },
          `${idempotencyKey}-${draft.id}`,
        );
      }
      let assigned = review;
      if (assignTo !== "") {
        assigned = await api.assignReview(review.id, review.version, assignTo);
      }
      return assigned;
    },
    onSuccess: (review) => {
      setCreated({ id: review.id, slug: review.slug });
      setFailure(null);
      onAnnounce(
        `Created review "${review.slug}" with ${String(drafts.length)} finding${
          drafts.length === 1 ? "" : "s"
        }.`,
      );
      onDone();
    },
    onError: (error) => {
      setFailure(error instanceof ApiFailure ? error : null);
      onAnnounce("The review was not created.");
    },
  });

  if (created !== null) {
    return (
      <div className={`${CARD} mt-4`} data-testid="review-created">
        <h3 className="text-sm font-semibold">Review created</h3>
        <p className="mt-1 text-sm">
          <span className="font-mono">{created.slug}</span> is the durable name an agent retrieves
          this review by.
        </p>
        <CliCommand slug={created.slug} outcome={copyOutcome} onOutcome={setCopyOutcome} />
      </div>
    );
  }

  if (drafts.length === 0) return null;

  return (
    <div className={`${CARD} mt-4`} data-testid="draft-findings">
      <h3 className="text-sm font-semibold">
        Draft findings ({drafts.length})
      </h3>
      <p className={`mt-1 ${HINT}`}>
        {recovered
          ? "Recovered from this browser tab. Nothing here has been saved to the control plane yet — naming a review below is what saves it."
          : "Held in this browser tab. Nothing here has been saved to the control plane yet — naming a review below is what saves it."}
      </p>

      <ul className="mt-3 flex flex-col gap-2">
        {drafts.map((draft) => (
          <li
            key={draft.id}
            data-draft-finding={draft.id}
            className="flex items-start gap-2 rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{draft.title}</p>
              <p className={HINT}>
                {draft.severity} · {draft.annotations.length} mark
                {draft.annotations.length === 1 ? "" : "s"} ·{" "}
                {draft.annotations
                  .map((mark) => describeGeometry(mark.type, mark.geometry))
                  .join("; ")}
              </p>
            </div>
            <button
              type="button"
              data-draft-remove={draft.id}
              aria-label={`Discard draft finding ${draft.title}`}
              className="shrink-0 rounded border border-red-700 px-3 py-2 text-sm font-medium text-red-800 dark:border-red-500 dark:text-red-300"
              onClick={() => {
                onRemove(draft.id);
              }}
            >
              Discard
            </button>
          </li>
        ))}
      </ul>

      {failure === null ? null : (
        <RefusalPanel
          code={failure.code}
          message={failure.message}
          attribute="data-failure"
          table={CAPTURE_REFUSALS}
          surface="create-review"
        />
      )}

      <form
        className="mt-4 flex flex-col gap-4"
        data-testid="create-review-form"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate("READY");
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="review-title" className="text-sm font-medium">
            Title
          </label>
          <input
            id="review-title"
            name="review-title"
            value={title}
            required
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            className={`${FIELD} w-full`}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="review-slug" className="text-sm font-medium">
            Slug
          </label>
          <input
            id="review-slug"
            name="review-slug"
            value={slug}
            placeholder={previewSlug(title)}
            onChange={(event) => {
              setSlug(event.target.value);
            }}
            className={`${FIELD} w-full font-mono`}
            aria-describedby="review-slug-hint"
          />
          <p id="review-slug-hint" className={HINT}>
            The name an agent retrieves this review by, unique among the project&apos;s active
            reviews. Leave it blank to use <span className="font-mono">{previewSlug(title)}</span>.
            The control plane decides whether it is acceptable.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="review-priority" className="text-sm font-medium">
            Priority
          </label>
          <select
            id="review-priority"
            name="review-priority"
            value={priority}
            onChange={(event) => {
              setPriority(event.target.value as ReviewPriority);
            }}
            className={`${FIELD} w-full sm:max-w-xs`}
            aria-describedby="review-priority-hint"
          >
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <p id="review-priority-hint" className={HINT}>
            Orders a queue. It gates nothing.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="review-instruction" className="text-sm font-medium">
            Instruction
          </label>
          <textarea
            id="review-instruction"
            name="review-instruction"
            rows={2}
            value={instruction}
            onChange={(event) => {
              setInstruction(event.target.value);
            }}
            className={`${FIELD} w-full`}
            placeholder="Fix these before continuing with the product page."
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="review-assign" className="text-sm font-medium">
            Assign to agent session (optional)
          </label>
          <input
            id="review-assign"
            name="review-assign"
            value={agentSessionId}
            placeholder="ags_…"
            onChange={(event) => {
              setAgentSessionId(event.target.value);
            }}
            className={`${FIELD} w-full font-mono sm:max-w-md`}
            aria-describedby="review-assign-hint"
          />
          <p id="review-assign-hint" className={HINT}>
            No endpoint lists a project&apos;s agent sessions yet, so the identifier is entered here
            rather than chosen from a list this surface would have to invent. Leave it blank to
            create the review unassigned and assign it later. Assignment is a direction and not a
            collection: the agent still has to fetch the review itself.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            id="review-save-draft"
            className={CONTROL}
            disabled={create.isPending}
            onClick={() => {
              create.mutate("DRAFT");
            }}
          >
            Save draft
          </button>
          <button type="submit" id="review-mark-ready" className={PRIMARY} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Mark ready and assign"}
          </button>
        </div>
      </form>

      <CliCommand slug={effectiveSlug} outcome={copyOutcome} onOutcome={setCopyOutcome} />
    </div>
  );
}

/**
 * The copyable command (`docs/UX_FLOWS.md` sections 10 and 11).
 *
 * It is offered, never delivered. The statement below it is affirmative on
 * purpose: section 11 forbids a claim that the control plane typed into a
 * terminal, and only a sentence that says the opposite can be tested for.
 */
function CliCommand({
  slug,
  outcome,
  onOutcome,
}: {
  readonly slug: string;
  readonly outcome: string;
  readonly onOutcome: (message: string) => void;
}): ReactElement {
  const command = cliCommand(slug);
  const clipboard = typeof navigator !== "undefined" && navigator.clipboard !== undefined;
  return (
    <div className="mt-4">
      <h4 className="text-sm font-semibold">Give this review to your agent</h4>
      <pre
        id="review-cli-command"
        data-testid="review-cli-command"
        tabIndex={0}
        className="mt-1 overflow-x-auto rounded border border-slate-300 bg-slate-100 p-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
      >
        {command}
      </pre>
      <button
        type="button"
        id="review-cli-copy"
        data-testid="review-cli-copy"
        disabled={!clipboard}
        className={`${CONTROL} mt-2`}
        onClick={() => {
          navigator.clipboard
            .writeText(command)
            .then(() => {
              onOutcome("Command copied to the clipboard.");
            })
            .catch(() => {
              onOutcome("The browser refused the clipboard. Select the command above and copy it.");
            });
        }}
      >
        Copy command
      </button>
      <p role="status" aria-live="polite" data-testid="review-cli-copy-outcome" className={HINT}>
        {clipboard
          ? outcome
          : "This browser offers no clipboard. Select the command above and copy it."}
      </p>
      <p data-testid="no-terminal-injection" className={`mt-1 ${HINT}`}>
        ReviewPlane does not type into an agent&apos;s terminal. Nothing reaches the agent until you
        run this command there.
      </p>
    </div>
  );
}

/**
 * The annotation list (`docs/UX_FLOWS.md` section 19).
 *
 * This is not a fallback. It is the non-canvas alternative, and it carries the
 * same information as the overlay: what each mark says, what shape it is and
 * where on the picture it sits. Somebody working entirely from a screen reader
 * gets the finding, not a summary of it.
 *
 * It is also what remains when overlay rendering fails, which is why it takes
 * no measurement, no artefact metadata and no browser API — only the stored
 * records.
 */

import type { ReactElement } from "react";

import { describeGeometry } from "@reviewplane/protocol/review";

import type { DisplayAnnotation } from "./AnnotationOverlay.tsx";

export interface AnnotationListProps {
  readonly annotations: readonly DisplayAnnotation[];
  readonly selectedId: string | null;
  readonly onSelect: (annotationId: string) => void;
  /**
   * Removes a mark. Present while a human is still drawing, absent once the
   * finding is saved: a stored annotation is withdrawn through the API and its
   * revisions are retained, which is a different act from discarding a mark
   * that was never recorded.
   */
  readonly onRemove?: (annotationId: string) => void;
  /** What the list says when it is empty. */
  readonly emptyMessage?: string;
  readonly testId?: string;
}

export function AnnotationList({
  annotations,
  selectedId,
  onSelect,
  onRemove,
  emptyMessage,
  testId = "annotation-list",
}: AnnotationListProps): ReactElement {
  if (annotations.length === 0) {
    return (
      <p className="text-sm text-slate-700 dark:text-slate-300">
        {emptyMessage ??
          "This finding has no annotations. The screenshot above is the whole of its evidence."}
      </p>
    );
  }

  return (
    <ol data-testid={testId} className="flex flex-col gap-2">
      {annotations.map((annotation, index) => (
        <li key={annotation.id} className="flex items-stretch gap-2">
          <button
            type="button"
            data-annotation-item={annotation.id}
            onClick={() => {
              onSelect(annotation.id);
            }}
            aria-pressed={annotation.id === selectedId}
            className={`min-w-0 flex-1 rounded border px-3 py-2 text-left text-sm ${
              annotation.id === selectedId
                ? "border-sky-600 bg-sky-50 dark:bg-sky-950"
                : "border-slate-300 dark:border-slate-700"
            }`}
          >
            <span className="font-medium">
              {annotation.marker_number ?? index + 1}. {annotation.label ?? "Unlabelled mark"}
            </span>
            <span className="mt-1 block text-slate-700 dark:text-slate-300">
              {describeGeometry(annotation.type, annotation.geometry)}
            </span>
          </button>
          {onRemove === undefined ? null : (
            <button
              type="button"
              data-annotation-remove={annotation.id}
              onClick={() => {
                onRemove(annotation.id);
              }}
              // The mark's own label is in the accessible name, so a list of
              // six "Remove" buttons is not six identical controls.
              aria-label={`Remove ${annotation.label ?? "unlabelled mark"}`}
              className="shrink-0 rounded border border-red-700 px-3 py-2 text-sm font-medium text-red-800 dark:border-red-500 dark:text-red-300"
            >
              Remove
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

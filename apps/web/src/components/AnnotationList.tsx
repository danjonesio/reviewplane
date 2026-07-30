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

import type { Annotation } from "../api/client.ts";

export interface AnnotationListProps {
  readonly annotations: readonly Annotation[];
  readonly selectedId: string | null;
  readonly onSelect: (annotationId: string) => void;
}

export function AnnotationList({
  annotations,
  selectedId,
  onSelect,
}: AnnotationListProps): ReactElement {
  if (annotations.length === 0) {
    return (
      <p className="text-sm text-slate-700 dark:text-slate-300">
        This finding has no annotations. The screenshot above is the whole of its evidence.
      </p>
    );
  }

  return (
    <ol data-testid="annotation-list" className="flex flex-col gap-2">
      {annotations.map((annotation, index) => (
        <li key={annotation.id}>
          <button
            type="button"
            data-annotation-item={annotation.id}
            onClick={() => {
              onSelect(annotation.id);
            }}
            aria-pressed={annotation.id === selectedId}
            className={`w-full rounded border px-3 py-2 text-left text-sm ${
              annotation.id === selectedId
                ? "border-sky-600 bg-sky-50 dark:bg-sky-950"
                : "border-slate-300 dark:border-slate-700"
            }`}
          >
            <span className="font-medium">
              {annotation.marker_number ?? index + 1}. {annotation.label}
            </span>
            <span className="mt-1 block text-slate-700 dark:text-slate-300">
              {describeGeometry(annotation.type, annotation.geometry)}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

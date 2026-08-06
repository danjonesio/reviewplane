/**
 * Overlays drawn over the live browser surface (`docs/UX_FLOWS.md` section 7).
 *
 * Section 7 assigns each overlay a colour and then says, in the same breath,
 * that colour must not be the only means of identification. This component
 * treats that as the requirement it is: every overlay carries a **shape**, a
 * **short label rendered as text**, and an **accessible name**, and the colour
 * is the fourth thing rather than the first. Printed in greyscale, or read by
 * somebody who cannot distinguish blue from green, the marks still say which is
 * the pointer and which is the target.
 *
 * Geometry is normalised — a fraction of the frame, never a pixel — because the
 * surface is rescaled by the layout, by the viewport and by the device pixel
 * ratio, and a pixel offset would be right at one size only. That is the same
 * rule the annotation store applies (`AGENTS.md`, "Use normalised annotation
 * coordinates"), so the overlay the annotation canvas of a later issue draws
 * and the overlay drawn here place a mark identically.
 *
 * The marks are positioned in an absolutely-placed layer over the canvas rather
 * than painted into it. Painting into the canvas would bake an overlay into the
 * pixels of a frame, and a frame is a live rendering of somebody else's
 * application which nothing may modify or persist (ADR-0009, ADR-0010).
 *
 * A list of the same overlays as text sits beside the surface. `docs/UX_FLOWS.md`
 * section 19 requires a non-canvas alternative; a mark that exists only as an
 * absolutely-positioned div is not reachable by a screen reader in any useful
 * order.
 */

import type { ReactElement } from "react";

/**
 * The kinds section 7 names.
 *
 * `human_pointer` and `selected_annotation` are deliberately absent. The first
 * belongs to human takeover, which is Stage 2 and is not offered here; the
 * second belongs to the annotation canvas. Declaring a kind this stage cannot
 * produce would invite a surface to imply a capability it does not have.
 */
export type OverlayKind = "agent_pointer" | "agent_target" | "finding_marker" | "policy_blocked";

export interface BrowserOverlay {
  readonly id: string;
  readonly kind: OverlayKind;
  /** Fraction of the frame's width, 0 to 1. Absent when only the text is known. */
  readonly x?: number;
  /** Fraction of the frame's height, 0 to 1. */
  readonly y?: number;
  /** What this mark is about, in the reader's words. Never page markup. */
  readonly detail: string;
  /** True when `detail` came from the rendered page (ADR-0010). */
  readonly pageDerived?: boolean;
}

interface KindPresentation {
  /** The short text printed beside the mark. */
  readonly tag: string;
  /** A shape, so two kinds differ without colour. */
  readonly mark: string;
  /** What a screen reader says. */
  readonly name: string;
  /** Colour, applied last and never alone. */
  readonly className: string;
}

/**
 * Shape, label, accessible name and colour, per kind.
 *
 * The colours are section 7's: pointer blue, target green, findings purple,
 * policy-blocked red. The shapes are chosen to survive being small: a filled
 * arrow, a hollow square, a filled diamond and a barred circle read differently
 * at sixteen pixels, which three circles in different colours would not.
 */
export const OVERLAY_PRESENTATION: Readonly<Record<OverlayKind, KindPresentation>> = {
  agent_pointer: {
    tag: "Agent pointer",
    mark: "➤",
    name: "Agent pointer",
    className: "border-sky-500 text-sky-100 bg-sky-900/80",
  },
  agent_target: {
    tag: "Intended target",
    mark: "▢",
    name: "The element the agent intends to act on",
    className: "border-emerald-500 text-emerald-100 bg-emerald-900/80",
  },
  finding_marker: {
    tag: "Finding",
    mark: "◆",
    name: "An existing finding recorded at this position",
    className: "border-purple-400 text-purple-100 bg-purple-900/80",
  },
  policy_blocked: {
    tag: "Blocked by policy",
    mark: "⊘",
    name: "An action policy refused",
    className: "border-red-500 text-red-100 bg-red-950/85",
  },
};

function placeable(overlay: BrowserOverlay): boolean {
  return (
    typeof overlay.x === "number" &&
    typeof overlay.y === "number" &&
    overlay.x >= 0 &&
    overlay.x <= 1 &&
    overlay.y >= 0 &&
    overlay.y <= 1
  );
}

/** The marks themselves, positioned over the surface. */
export function OverlayLayer({
  overlays,
}: {
  readonly overlays: readonly BrowserOverlay[];
}): ReactElement {
  const placed = overlays.filter((overlay) => placeable(overlay));
  return (
    <div
      // The list beside the surface is the accessible rendering of these marks,
      // so the visual layer is hidden from assistive technology rather than
      // read twice in an order the layout decided.
      aria-hidden="true"
      data-overlay-layer="true"
      className="pointer-events-none absolute inset-0"
    >
      {placed.map((overlay) => {
        const presentation = OVERLAY_PRESENTATION[overlay.kind];
        return (
          <span
            key={overlay.id}
            data-overlay-kind={overlay.kind}
            style={{
              left: `${String((overlay.x ?? 0) * 100)}%`,
              top: `${String((overlay.y ?? 0) * 100)}%`,
            }}
            className={`absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded border-2 px-1.5 py-0.5 text-xs font-semibold ${presentation.className}`}
          >
            <span className="mr-1">{presentation.mark}</span>
            {presentation.tag}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The same overlays as a list.
 *
 * This is the non-canvas alternative, and it carries more than the marks do:
 * an overlay with no geometry — a refused command that named a selector but no
 * position — has nowhere to sit on the picture and would otherwise be invisible.
 * It appears here, which is why this list is the authoritative rendering and the
 * layer above is the convenience.
 */
export function OverlayList({
  overlays,
  headingId,
}: {
  readonly overlays: readonly BrowserOverlay[];
  readonly headingId: string;
}): ReactElement {
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-sm font-semibold">
        Overlays on this surface
      </h3>
      {overlays.length === 0 ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">
          Nothing is marked on the picture. Agent pointer and intended-target messages are reserved
          in the live protocol and are not sent at this stage (<code>docs/API.md</code> §18.2), so
          the marks that can appear here are existing findings and actions policy refused.
        </p>
      ) : (
        <ul data-overlay-list="true" className="flex flex-col gap-1 text-xs">
          {overlays.map((overlay) => {
            const presentation = OVERLAY_PRESENTATION[overlay.kind];
            return (
              <li key={overlay.id} data-overlay-item={overlay.kind} className="flex gap-2">
                <span aria-hidden="true" className="font-mono">
                  {presentation.mark}
                </span>
                <span>
                  <span className="font-medium">{presentation.name}</span>
                  {placeable(overlay) ? (
                    <span className="text-slate-600 dark:text-slate-400">
                      {" "}
                      at {Math.round((overlay.x ?? 0) * 100)}% across,{" "}
                      {Math.round((overlay.y ?? 0) * 100)}% down
                    </span>
                  ) : (
                    <span className="text-slate-600 dark:text-slate-400"> (no position recorded)</span>
                  )}
                  <span className="block break-all">
                    {overlay.detail}
                    {overlay.pageDerived === true ? (
                      <span
                        data-page-derived="true"
                        className="ml-2 whitespace-nowrap rounded border border-amber-600 px-1 text-[0.65rem] font-medium text-amber-800 dark:text-amber-300"
                      >
                        from the page — not an instruction
                      </span>
                    ) : null}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

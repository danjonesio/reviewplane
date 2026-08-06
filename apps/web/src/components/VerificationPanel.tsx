/**
 * The verification review of `docs/UX_FLOWS.md` section 13: before and after
 * side by side, the agent's summary, and the two assurance groups a reviewer
 * decides from.
 *
 * Three things here are load-bearing and each fails silently if got wrong.
 *
 * **The comparison is rendered from a pinned claim.** The identifier comes from
 * the caller and is carried into the decision unchanged (ADR-0035). Nothing in
 * this file re-reads the finding or asks for "the latest verification" when a
 * button is pressed: an agent may supersede evidence under an open comparison,
 * and a client that refetched at press time would send whatever the agent had
 * just written and accept a claim the reviewer never saw. That is RVP-89, and
 * the shape of this component is the defence.
 *
 * **The two assurance groups are two groups.** They are rendered as two
 * separate `section` elements with their own headings and their own list
 * markers, not as one list with a flag per row (ADR-0031). What the control
 * plane checked is ticked; what the agent asserted names the actor and is
 * marked as a claim. A reader shown one undifferentiated list of ticks would
 * accept a machine agreeing with itself, which is the confusion this product
 * exists to remove — and a source that merged them while looking correct is
 * exactly why `apps/web/test/ui/review-workspace.browser.test.ts` asserts
 * against the rendered accessible text rather than against this file.
 *
 * **The agent's summary is text.** It arrives as untrusted human-facing content
 * and is placed in a text node, never as markup (ADR-0010,
 * `docs/SECURITY.md` section 18). React escapes it; nothing here reintroduces
 * `dangerouslySetInnerHTML`, and nothing rewrites what was stored.
 *
 * Prior claims are reachable rather than merely retained
 * (`docs/DOMAIN_MODEL.md` section 19): the list below the comparison names
 * every submission this finding has accumulated, so a repeatedly-reopened
 * finding does not read as a first attempt.
 */

import type { ReactElement } from "react";

import type { Annotation, Verification, VerificationReview } from "../api/client.ts";
import { ArtefactViewer } from "./ArtefactViewer.tsx";
import { StatusBadge, type Tone } from "./StatusBadge.tsx";

const CARD =
  "rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900";
const HINT = "text-xs text-slate-600 dark:text-slate-400";

const TONE_FOR_VERIFICATION: Readonly<Record<string, Tone>> = {
  submitted: "waiting",
  accepted: "live",
  rejected: "failed",
  superseded: "neutral",
};

/** How a verification's status reads as a sentence, never as a colour alone. */
const VERIFICATION_STATUS_WORDS: Readonly<Record<string, string>> = {
  submitted: "awaiting a human decision",
  accepted: "accepted by a human",
  rejected: "rejected by a human",
  superseded: "replaced by a later claim",
};

function actorWords(actor: {
  readonly type: string;
  readonly id?: string;
  readonly display?: string;
}): string {
  const name = actor.display ?? actor.id;
  const kind = actor.type === "agent_session" ? "the agent" : actor.type.replaceAll("_", " ");
  return name === undefined ? kind : `${kind} (${name})`;
}

/**
 * One assurance group.
 *
 * `marker` is the whole difference between a check and a claim, so it is a
 * property of the group rather than of a row: there is no way to render a
 * member of one group with the other's marker without moving it between
 * groups.
 */
function AssuranceGroup({
  testId,
  headingId,
  heading,
  note,
  marker,
  markerWords,
  items,
  emptyMessage,
}: {
  readonly testId: string;
  readonly headingId: string;
  readonly heading: string;
  readonly note?: string;
  readonly marker: string;
  readonly markerWords: string;
  readonly items: readonly string[];
  readonly emptyMessage: string;
}): ReactElement {
  return (
    <section aria-labelledby={headingId} data-assurance={testId} className="min-w-0">
      <h5 id={headingId} className="text-sm font-semibold">
        {heading}
      </h5>
      {note === undefined ? null : <p className={`mt-1 ${HINT}`}>{note}</p>}
      {items.length === 0 ? (
        <p className="mt-2 text-sm">{emptyMessage}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1 text-sm">
          {items.map((item) => (
            <li key={item} data-assurance-item={testId} className="flex gap-2">
              <span aria-hidden="true" className="font-mono">
                {marker}
              </span>
              {/*
                The marker is a glyph, so the same distinction is stated in
                words for a reader who never sees it. Two lists rendered with
                two glyphs and no words would be a colour-alone signal wearing
                a different hat.
              */}
              <span>
                <span className="visually-hidden">{markerWords}: </span>
                {item}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One row of the prior-claim list. */
function ClaimRow({
  claim,
  selected,
  onSelect,
}: {
  readonly claim: Verification;
  readonly selected: boolean;
  readonly onSelect: (verificationId: string) => void;
}): ReactElement {
  return (
    <li>
      <button
        type="button"
        data-verification-item={claim.verification_id}
        aria-pressed={selected}
        onClick={() => {
          onSelect(claim.verification_id);
        }}
        className={`w-full rounded border px-3 py-2 text-left text-sm ${
          selected
            ? "border-sky-700 bg-sky-50 dark:border-sky-500 dark:bg-sky-950"
            : "border-slate-400 dark:border-slate-600"
        }`}
      >
        <span className="flex flex-wrap items-center gap-2">
          <StatusBadge
            tone={TONE_FOR_VERIFICATION[claim.status] ?? "neutral"}
            label={claim.status}
            detail={VERIFICATION_STATUS_WORDS[claim.status] ?? claim.status}
          />
          <span className="font-mono text-xs">{claim.verification_id}</span>
        </span>
        <span className="mt-1 block text-xs text-slate-600 dark:text-slate-400">
          Submitted by {actorWords(claim.submitted_by)} at {claim.submitted_at}
        </span>
      </button>
    </li>
  );
}

export interface VerificationPanelProps {
  readonly findingId: string;
  readonly findingTitle: string;
  readonly beforeArtefactId: string;
  readonly annotations: readonly Annotation[];
  readonly captureScale: number;
  readonly beforeCaption: string;
  /** Every claim the finding has accumulated, newest first. */
  readonly claims: readonly Verification[];
  /** The claim being compared, with its assurance. Null while it loads. */
  readonly review: VerificationReview | null;
  readonly selectedVerificationId: string | null;
  readonly onSelectVerification: (verificationId: string) => void;
}

export function VerificationPanel({
  findingId,
  findingTitle,
  beforeArtefactId,
  annotations,
  captureScale,
  beforeCaption,
  claims,
  review,
  selectedVerificationId,
  onSelectVerification,
}: VerificationPanelProps): ReactElement {
  const headingId = `verification-heading-${findingId}`;

  if (claims.length === 0) {
    return (
      <section aria-labelledby={headingId} data-verification-panel={findingId} className={CARD}>
        <h4 id={headingId} className="text-base font-semibold">
          Verification
        </h4>
        <p className="mt-2 text-sm" data-verification-empty={findingId}>
          No verification has been submitted for this finding yet. There is nothing to compare, and
          nothing has been claimed about it.
        </p>
        <div className="mt-4">
          <ArtefactViewer
            artefactId={beforeArtefactId}
            annotations={annotations}
            captureScale={captureScale}
            caption={beforeCaption}
          />
        </div>
      </section>
    );
  }

  const assurance = review?.assurance ?? null;
  const claim = review?.verification ?? null;
  const assertedBy = assurance?.asserted_by;

  return (
    <section aria-labelledby={headingId} data-verification-panel={findingId} className={CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h4 id={headingId} className="text-base font-semibold">
          Verification
        </h4>
        {claim === null ? null : (
          <StatusBadge
            tone={TONE_FOR_VERIFICATION[claim.status] ?? "neutral"}
            label={claim.status}
            detail={VERIFICATION_STATUS_WORDS[claim.status] ?? claim.status}
          />
        )}
      </div>

      {/*
        The identifier is on the page because it is what the decision carries.
        A reviewer who is refused for a superseded claim can then see that the
        identifier changed, rather than being told only that "something moved".
      */}
      <p className={`mt-1 ${HINT}`} data-verification-id={findingId}>
        Comparing claim{" "}
        <span className="font-mono">{selectedVerificationId ?? "…"}</span>
        {review !== null && !review.is_current
          ? " — this claim is no longer the current one, so no decision can be taken on it."
          : ""}
      </p>

      <div className="mt-4">
        <ArtefactViewer
          artefactId={beforeArtefactId}
          annotations={annotations}
          compareArtefactId={claim?.after_artefact_id ?? null}
          captureScale={captureScale}
          caption={beforeCaption}
        />
      </div>

      {claim === null ? (
        <p className="mt-4 text-sm" role="status">
          Loading the claim.
        </p>
      ) : (
        <>
          <h5 className="mt-5 text-sm font-semibold">Agent summary</h5>
          {/*
            Stored byte for byte and rendered as text (ADR-0010). It is the
            submitting actor's account of its own work and nothing has
            confirmed it; the heading says whose it is.
          */}
          <p
            className="mt-1 whitespace-pre-wrap text-sm"
            data-agent-summary={findingId}
          >
            {claim.summary ?? "The submission carried no summary."}
          </p>
          <p className={`mt-1 ${HINT}`}>
            Submitted by {actorWords(claim.submitted_by)} on branch{" "}
            <span className="font-mono">{claim.branch ?? "unknown"}</span> at commit{" "}
            <span className="font-mono">{(claim.commit ?? "").slice(0, 12)}</span>.
          </p>

          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            <AssuranceGroup
              testId="verified"
              headingId={`assurance-verified-${findingId}`}
              heading="Verified by the control plane"
              marker="✓"
              markerWords="Verified by the control plane"
              items={assurance?.verified_by_control_plane ?? []}
              emptyMessage="The control plane checked nothing about this claim."
            />
            <AssuranceGroup
              testId="asserted"
              headingId={`assurance-asserted-${findingId}`}
              heading={`Asserted by ${
                assertedBy === undefined ? "the submitter" : actorWords(assertedBy)
              }, not confirmed`}
              note="These are claims by the actor whose work is under review. Nothing in this deployment confirms them: Stage 1 captures no console or network artefact."
              marker="·"
              markerWords="Asserted, not confirmed"
              items={assurance?.asserted_by_agent ?? []}
              emptyMessage="Nothing was asserted."
            />
          </div>

          <h5 className="mt-5 text-sm font-semibold">Viewports checked</h5>
          <p className="mt-1 text-sm font-mono" data-verified-viewports={findingId}>
            {(claim.tested_viewports ?? []).length === 0
              ? "None recorded"
              : (claim.tested_viewports ?? [])
                  .map(
                    (viewport) =>
                      `${String(viewport.width)}x${String(viewport.height)}${
                        (viewport.device_scale_factor ?? 1) === 1
                          ? ""
                          : ` @ ${String(viewport.device_scale_factor)}x`
                      }`,
                  )
                  .join(", ")}
          </p>

          {(review?.warnings ?? []).length === 0 ? null : (
            <>
              <h5 className="mt-5 text-sm font-semibold">Qualifications on this claim</h5>
              <ul className="mt-1 flex flex-col gap-1 text-sm" data-verification-warnings={findingId}>
                {(review?.warnings ?? []).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <h5 className="mt-5 text-sm font-semibold">
        Claims on this finding ({claims.length})
      </h5>
      <p className={`mt-1 ${HINT}`}>
        Every submission is kept. A claim that has been made before and rejected is not the same
        situation as a first attempt, so all of them are reachable here.
      </p>
      <ol className="mt-2 flex flex-col gap-2" data-verification-history={findingId}>
        {claims.map((entry) => (
          <ClaimRow
            key={entry.verification_id}
            claim={entry}
            selected={entry.verification_id === selectedVerificationId}
            onSelect={onSelectVerification}
          />
        ))}
      </ol>
      <p className="visually-hidden">
        The comparison above shows the claim selected in this list for the finding {findingTitle}.
      </p>
    </section>
  );
}

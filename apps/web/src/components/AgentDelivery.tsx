/**
 * Where a review is, on its way to an agent (`docs/UX_FLOWS.md` sections 11
 * and 15).
 *
 * Three facts are shown and nothing is inferred between them. Assignment says
 * who the review was handed to; the inbox status says what became of the
 * delivery; the acknowledgement says whether the recipient has collected it.
 * A panel that derived the third from the second would report an agent as
 * having the work the moment a human assigned it, which is the one claim this
 * surface exists to avoid making.
 *
 * The assignment is rendered as the identifier the control plane holds. There
 * is no endpoint that resolves an agent session to a client's name, so a
 * friendlier label here would be invented rather than read
 * (`docs/API.md` section 4.3 on values that are worse than absent ones).
 *
 * The command block is the manual path of section 15. It is text a person
 * copies and runs themselves: `docs/UX_FLOWS.md` section 11 forbids claiming
 * that the control plane put anything into a terminal, and no adapter here
 * does.
 */

import { useQuery } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";

import { ApiFailure, api, type InboxItem, type Review } from "../api/client.ts";
import { StatusBadge, type Tone } from "./StatusBadge.tsx";

/**
 * Colour is decoration over the status word `StatusBadge` already prints, so a
 * status this map does not know is still readable rather than invisible.
 */
const TONE_FOR_INBOX_STATUS: Readonly<Record<string, Tone>> = {
  pending: "waiting",
  acknowledged: "live",
  completed: "neutral",
  dismissed: "neutral",
  expired: "warning",
};

const CARD = "rounded border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900";

/**
 * The command a person runs to hand this review over by hand.
 *
 * The second line is a shell comment so the whole block can be pasted at a
 * prompt without the prose breaking it, and the slug is what the agent resolves
 * the review by (`docs/MCP_SPEC.md` section 3.1).
 */
function manualPromptCommand(slug: string): string {
  return ["reviewplane-connector mcp", `# then, in the agent: work the review ${slug}`].join("\n");
}

/**
 * The command, and a control that copies it.
 *
 * A browser that exposes no clipboard gets a disabled button and is told why,
 * rather than a control that throws when pressed. The command itself is
 * focusable and selectable in either case, so the keyboard route out does not
 * depend on the clipboard being there (`docs/UX_FLOWS.md` section 19).
 */
function ManualPrompt({ slug }: { readonly slug: string }): ReactElement {
  const [outcome, setOutcome] = useState("");
  const command = manualPromptCommand(slug);
  // Not every browser exposes the clipboard, and one that does may still refuse
  // the write; neither is the reader's mistake.
  const clipboard = navigator.clipboard as Clipboard | undefined;

  async function copyCommand(): Promise<void> {
    if (clipboard === undefined) return;
    try {
      await clipboard.writeText(command);
      setOutcome("The command is on the clipboard. Run it yourself in the agent's terminal.");
    } catch {
      setOutcome(
        "This browser did not allow copying. Select the command above and copy it with the keyboard.",
      );
    }
  }

  return (
    <div className={CARD}>
      <h3 className="text-base font-semibold">Prompt an agent by hand</h3>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
        Copying puts this command on your clipboard for you to run. ReviewPlane does not type
        into an agent&apos;s terminal, so nothing reaches the agent until you run it there.
      </p>
      {/*
        Focusable and selectable, so the command can be copied by hand where the
        clipboard is unavailable.
      */}
      <pre
        id="agent-delivery-command"
        tabIndex={0}
        aria-label="Command for prompting an agent with this review"
        className="mt-3 max-w-full overflow-x-auto rounded border border-slate-300 bg-slate-50 p-4 text-xs dark:border-slate-700 dark:bg-slate-950"
      >
        <code>{command}</code>
      </pre>
      <p className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          id="copy-agent-delivery-command"
          disabled={clipboard === undefined}
          onClick={() => {
            void copyCommand();
          }}
          className="rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:bg-slate-400 dark:disabled:bg-slate-600"
        >
          Copy command
        </button>
        <span className="text-sm text-slate-600 dark:text-slate-400">
          {clipboard === undefined
            ? "This browser exposes no clipboard. Focus the command above and copy it with the keyboard."
            : "Or focus the command and copy it with the keyboard: it is selectable text."}
        </span>
      </p>
      <p
        id="agent-delivery-copy-status"
        role="status"
        aria-live="polite"
        className="mt-2 text-sm text-slate-700 dark:text-slate-300"
      >
        {outcome}
      </p>
    </div>
  );
}

/** Who the review was handed to, in the terms the control plane holds it. */
function assigneeText(review: Review): string | null {
  const agentSession = review.assigned_agent_session_id ?? null;
  if (agentSession !== null) return `agent session ${agentSession}`;
  const user = review.assigned_user_id ?? null;
  if (user !== null) return `user ${user}`;
  return null;
}

export function AgentDeliveryPanel({ review }: { readonly review: Review }): ReactElement {
  const inbox = useQuery({
    queryKey: ["inbox", review.project_id],
    queryFn: () => api.inbox(review.project_id),
  });

  // The inbox is a project's, so the item for this review is picked out here
  // rather than asked for: there is no per-review inbox endpoint, and inventing
  // one in the client would be a second place to define the relation.
  const item: InboxItem | null =
    (inbox.data ?? []).find((candidate) => candidate.review_id === review.id) ?? null;
  const assignee = assigneeText(review);
  const delivered = assignee !== null || item !== null;

  return (
    <section aria-labelledby="agent-delivery-heading" className="mt-6 flex flex-col gap-3">
      <h2 id="agent-delivery-heading" className="text-lg font-semibold">
        Agent delivery
      </h2>

      {inbox.isPending ? <p role="status">Reading the inbox.</p> : null}

      {inbox.isError ? (
        <p role="alert" className="text-sm font-medium text-red-800 dark:text-red-300">
          {inbox.error instanceof ApiFailure
            ? `${inbox.error.code}: ${inbox.error.message}`
            : "The inbox could not be read."}
        </p>
      ) : null}

      {!inbox.isPending && !inbox.isError && !delivered ? (
        <div className={CARD} data-empty="agent-delivery">
          <h3 className="text-base font-semibold">This review has not been delivered to an agent</h3>
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
            Nobody is assigned to it and no inbox item carries it, so there is no delivery to
            report and no acknowledgement to wait for. The command below is how a person hands it
            to an agent themselves.
          </p>
        </div>
      ) : null}

      {delivered ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-slate-600 dark:text-slate-400">Assigned to</dt>
            {/*
              The identifier itself. Nothing resolves it to a client's name, and
              a name this layer guessed would read as one the control plane
              knows.
            */}
            <dd
              id="agent-delivery-assignee"
              className="break-all font-mono"
              {...(assignee === null ? { "data-empty": "agent-delivery-assignment" } : {})}
            >
              {assignee ?? "Not assigned"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-slate-600 dark:text-slate-400">Inbox</dt>
            <dd id="agent-delivery-inbox" className="mt-1">
              {item === null ? (
                <span data-empty="agent-delivery-inbox">No inbox item</span>
              ) : (
                <StatusBadge
                  tone={TONE_FOR_INBOX_STATUS[item.status] ?? "neutral"}
                  label={item.status}
                />
              )}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-slate-600 dark:text-slate-400">Agent acknowledgement</dt>
            {/*
              Read from the acknowledgement time and never from the status: an
              item can be completed by somebody who never acknowledged it
              (`docs/DOMAIN_MODEL.md` section 21), and "not yet received" is then
              the true statement rather than the tidy one.
            */}
            <dd id="agent-delivery-acknowledgement">
              {item === null || item.acknowledged_at === null
                ? "not yet received"
                : new Date(item.acknowledged_at).toLocaleString()}
            </dd>
          </div>
        </dl>
      ) : null}

      <ManualPrompt slug={review.slug} />
    </section>
  );
}

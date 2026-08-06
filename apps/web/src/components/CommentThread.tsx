/**
 * The discussion on a review or a finding (`docs/DOMAIN_MODEL.md` section 18).
 *
 * Two properties are the reason this is a component rather than a list.
 *
 * **Attribution is explicit and comes from the server.** A reader must be able
 * to tell an agent's note from a human's, and the actor type is on every row in
 * words rather than by styling: the server derives it from the authenticated
 * actor and the request body has no author field, so the type shown here is a
 * fact and not a claim.
 *
 * **Comment bodies render inert.** An agent's comment is untrusted
 * human-facing content and reaches this page as text (ADR-0010,
 * `docs/SECURITY.md` section 18). It is placed in a text node; nothing here
 * interprets it as markup, and nothing rewrites what was stored — a sanitiser
 * that changed the bytes would break the first property while appearing to
 * satisfy the second.
 *
 * A reopen's reason arrives here as a comment by the deciding human
 * (ADR-0036), which is why the thread is on the finding card rather than
 * somewhere a reviewer would have to go and look.
 */

import { useState, type ReactElement } from "react";

import { ApiFailure, type Comment } from "../api/client.ts";
import { RefusalPanel, SHARED_REFUSALS } from "./refusals.tsx";

const FIELD =
  "w-full rounded border border-slate-400 bg-white px-3 py-2 text-base dark:border-slate-600 dark:bg-slate-900";
const HINT = "text-xs text-slate-600 dark:text-slate-400";
const PRIMARY =
  "self-start rounded bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60";

/** What each actor type is called where a reader sees it. */
const AUTHOR_WORDS: Readonly<Record<string, string>> = {
  human_user: "a human",
  agent_session: "an agent",
  system: "the system",
  connector: "a connector",
  browser_worker: "a browser worker",
  integration: "an integration",
};

export interface CommentThreadProps {
  readonly surface: string;
  readonly headingId: string;
  readonly heading: string;
  readonly comments: readonly Comment[];
  readonly pending: boolean;
  readonly failure: unknown;
  readonly onAdd: (body: string) => void;
}

export function CommentThread({
  surface,
  headingId,
  heading,
  comments,
  pending,
  failure,
  onAdd,
}: CommentThreadProps): ReactElement {
  const [draft, setDraft] = useState("");
  const refusal = failure instanceof ApiFailure ? failure : null;

  return (
    <section aria-labelledby={headingId} data-comments={surface} className="mt-5">
      <h5 id={headingId} className="text-sm font-semibold">
        {heading}
      </h5>
      {comments.length === 0 ? (
        <p className="mt-2 text-sm" data-comments-empty={surface}>
          Nothing has been said here yet.
        </p>
      ) : (
        <ol className="mt-2 flex flex-col gap-3">
          {comments.map((comment) => (
            <li
              key={`${comment.id}-${String(comment.revision)}`}
              data-comment={comment.id}
              data-comment-author={comment.created_by.type}
              className="rounded border border-slate-300 p-3 dark:border-slate-700"
            >
              <p className={HINT}>
                {AUTHOR_WORDS[comment.created_by.type] ?? comment.created_by.type}
                {comment.created_by.display === undefined
                  ? ""
                  : ` (${comment.created_by.display})`}{" "}
                at {comment.created_at}
                {comment.revision > 1 ? ` — revision ${String(comment.revision)}` : ""}
              </p>
              {/* Text, never markup. React escapes it and nothing bypasses that. */}
              <p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <label htmlFor={`comment-draft-${surface}`} className="text-sm font-medium">
          Add a comment
        </label>
        <textarea
          id={`comment-draft-${surface}`}
          data-comment-draft={surface}
          rows={3}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          className={FIELD}
        />
        <button
          type="button"
          data-comment-submit={surface}
          disabled={pending || draft.trim() === ""}
          onClick={() => {
            onAdd(draft);
            setDraft("");
          }}
          className={PRIMARY}
        >
          {pending ? "Adding" : "Add comment"}
        </button>
      </div>

      {refusal === null ? null : (
        <RefusalPanel
          code={refusal.code}
          message={refusal.message}
          attribute="data-refusal"
          table={SHARED_REFUSALS}
          surface={`comment-${surface}`}
        />
      )}
    </section>
  );
}

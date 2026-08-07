/**
 * Refusals, as titles and actions rather than as apologies
 * (`docs/UX_FLOWS.md` section 18).
 *
 * Section 18 forbids answering a named cause with "something went wrong", so
 * every surface that can meet a stable code holds one title and one action for
 * it: what happened, and what the reader can do next. This module owns the
 * treatment — one panel, one lookup — and the wording lives in tables beside
 * it.
 *
 * The wording is per surface and the mechanism is not, deliberately. A code
 * such as `AUTHORISATION_DENIED` names the same refusal wherever it arrives,
 * but the sentence that helps a reader differs: on the publication surface
 * nothing was published, and on the session surface no browser was started and
 * no capability was minted. One table for both would have to say neither.
 * `SHARED_REFUSALS` therefore holds the codes whose wording genuinely does not
 * vary, and each surface spreads it into its own table.
 *
 * `RESOURCE_NOT_FOUND` is the clearest of those. The API answers it identically
 * for an identifier that does not exist and one this session is not authorised
 * for, so that neither can be used to enumerate the other (`docs/API.md` §5),
 * and section 18 requires the UI to leave that ambiguity where it found it.
 */

import type { ReactElement } from "react";

import { explain, type RefusalTable } from "./refusal-tables.ts";

export {
  SHARED_REFUSALS,
  PUBLICATION_REFUSALS,
  BROWSER_SESSION_REFUSALS,
  EVENT_STREAM_REFUSALS,
  type Explanation,
  type RefusalTable,
  explain,
} from "./refusal-tables.ts";

const HINT = "text-xs text-slate-600 dark:text-slate-400";

/** A title and an action, as a panel rather than as a sentence in passing. */
export function RefusalPanel({
  code,
  message,
  attribute,
  table,
  surface,
}: {
  readonly code: string;
  readonly message: string;
  readonly attribute: "data-refusal" | "data-failure";
  readonly table: RefusalTable;
  /**
   * Which surface refused, for a suite that needs to find this panel and not
   * another one on the same page. The code stays in `data-refusal`, because
   * selecting a refusal by its code is what proves the right explanation was
   * rendered rather than merely that something red appeared.
   */
  readonly surface?: string;
}): ReactElement {
  const explanation = explain(table, code, message);
  return (
    <div
      data-refusal={attribute === "data-refusal" ? code : undefined}
      data-failure={attribute === "data-failure" ? code : undefined}
      data-surface={surface}
      role="alert"
      className="mt-3 rounded border-2 border-red-700 p-3 dark:border-red-500"
    >
      <h5 className="text-sm font-semibold text-red-800 dark:text-red-300">{explanation.title}</h5>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{explanation.action}</p>
      <p className={`mt-2 ${HINT}`}>
        Reported as <span className="font-mono">{code}</span>.
      </p>
    </div>
  );
}

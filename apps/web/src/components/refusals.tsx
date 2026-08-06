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

const HINT = "text-xs text-slate-600 dark:text-slate-400";

export interface Explanation {
  readonly title: string;
  readonly action: string;
}

export type RefusalTable = Readonly<Record<string, Explanation>>;

/** The codes whose meaning and whose action are the same on every surface. */
export const SHARED_REFUSALS: RefusalTable = {
  RESOURCE_NOT_FOUND: {
    title: "This does not exist, or this session is not authorised for it",
    action:
      "The control plane answers an identifier that does not exist and one this session may not reach identically, so that neither can be used to find the other. This page does not guess which it was.",
  },
};

/**
 * One title and one action for every stable code the publication surface can
 * meet (`docs/API.md` section 10, `docs/CONNECTOR_PROTOCOL.md` section 21).
 *
 * `CONNECTOR_OFFLINE` and `CONTROL_PLANE_UNAVAILABLE` share a title and not an
 * action: both are the tunnel being unavailable, and the difference is whether
 * the connector held a channel at all — which is what decides whether waiting
 * is worth anything.
 */
export const PUBLICATION_REFUSALS: RefusalTable = {
  ...SHARED_REFUSALS,
  PORT_NOT_LISTENING: {
    title: "The development service is not listening",
    action:
      "Nothing was listening on that host and port on the development machine, and the bounded startup grace ended without it appearing. Start the development server there and publish again.",
  },
  CONNECTOR_OFFLINE: {
    title: "The tunnel is unavailable",
    action:
      "The connector holds no channel to this control plane, so nothing could carry the route. A connector that stopped reporting usually dials back in on its own; check the environment, then publish again.",
  },
  CONTROL_PLANE_UNAVAILABLE: {
    title: "The tunnel is unavailable",
    action:
      "The connector holds a channel but did not answer within the bounded wait, so no route was published and none was left half-open. Publish again once the environment reports healthy.",
  },
  DESTINATION_NOT_ALLOWED: {
    title: "That destination is not allowed",
    action:
      "The host and port fall outside the destination policy this deployment enforces, so no record was written. Publish a destination the policy permits, or have an administrator change the policy.",
  },
  ROUTE_LIMIT_EXCEEDED: {
    title: "This connector is carrying too many routes",
    action:
      "The concurrent-route limit is already reached. Revoke a route this environment no longer needs, then publish again.",
  },
  ROUTE_EXPIRED: {
    title: "The route's lifetime had already elapsed",
    action:
      "Publication expires by itself and is not extended in place. Publish again with a lifetime long enough for the work.",
  },
  PUBLISHED_SERVICE_UNAVAILABLE: {
    title: "This deployment no longer carries that route",
    action:
      "The route was revoked, expired, or was never carried. Publish a new one; the browser sessions it authorises have to be named again.",
  },
  POLICY_DENIED: {
    title: "Policy refused this publication",
    action:
      "A policy of this project or organisation forbids publishing this destination. Nothing was created; an administrator can change the policy.",
  },
  PROJECT_NOT_AUTHORISED: {
    title: "The connector is not authorised for this project",
    action:
      "The connector refused the publication because it is not enrolled for this project. Publish from an environment that is, or enrol a connector here.",
  },
  WORKSPACE_NOT_FOUND: {
    title: "The connector does not report that checkout",
    action:
      "Choose a checkout the environment currently reports. The list refreshes as the connector reports, so a checkout that has just moved may take a moment.",
  },
  VALIDATION_FAILED: {
    title: "The publication request was incomplete",
    action:
      "One of the values is missing or out of range. Check the port and the lifetime, then publish again.",
  },
  AUTHORISATION_DENIED: {
    title: "This session may not publish here",
    action: "The control plane refused the request. Nothing was created and no route changed.",
  },
};

/**
 * One title and one action for every stable code starting, pausing, resuming or
 * ending a browser session can meet (`docs/API.md` section 11,
 * `docs/UX_FLOWS.md` sections 6, 7 and 18).
 *
 * `BROWSER_CAPACITY_EXHAUSTED` is the one section 18 names that this deployment
 * meets first and most often, and it is the one most easily read as a fault. It
 * is not: nothing is broken, the deployment is full, and the actions that clear
 * it are the reader's own.
 *
 * `CONTROL_EPOCH_STALE` is not a failure of this page either. Exactly one
 * controller drives a browser at a time, and the epoch is how that is enforced
 * (`docs/DESIGN_PRINCIPLES.md` §6): a refused epoch means control moved, so the
 * page says so and reads the session again rather than leaving a stale number
 * on screen for the reader to retry against.
 */
export const BROWSER_SESSION_REFUSALS: RefusalTable = {
  ...SHARED_REFUSALS,
  BROWSER_CAPACITY_EXHAUSTED: {
    title: "This deployment has no free browser slot",
    action:
      "Every browser worker this deployment has is at its session limit, or no worker is reporting at all, so no Chromium could be allocated and no session was created. Wait for a running session to end, end one from the list below, or ask the operator to check the deployment's browser capacity with reviewplane status.",
  },
  PROJECT_CONTEXT_MISMATCH: {
    title: "That route belongs to another project",
    action:
      "The published service named here was created in a different project, and a session may reach only a route of its own project. Choose a route this project published, or publish one here first.",
  },
  BROWSER_SESSION_NOT_ACTIVE: {
    title: "This session is not in a state that accepts that",
    action:
      "The session has ended, failed, or has not been allocated on a worker yet, so pausing, resuming or driving it does nothing. The session has been read again; if it has ended, start a new one.",
  },
  CONTROL_EPOCH_STALE: {
    title: "Browser control changed",
    action:
      "Something else took control of this browser after this page last read it, so the control epoch sent with the request is no longer current and the request was refused before it reached the worker. The session has been read again; repeat the action against the epoch now shown.",
  },
  CONTROL_NOT_OWNED: {
    title: "This page does not hold browser control",
    action:
      "The control lease belongs to another controller, and only its holder may drive the browser. Take control first, or wait for the current controller to release it.",
  },
  POLICY_DENIED: {
    title: "Policy refused this browser session",
    action:
      "A policy of this project or organisation forbids starting or driving a browser session on these terms. Nothing was created or changed; an administrator can change the policy.",
  },
  AUTHORISATION_DENIED: {
    title: "This session may not do that here",
    action:
      "The control plane refused the request. No browser session was started or changed, and no route capability was minted.",
  },
  VALIDATION_FAILED: {
    title: "The request was incomplete",
    action:
      "One of the values is missing or out of range. Check the viewport and the development service chosen above, then try again.",
  },
  UNSUPPORTED_CAPABILITY: {
    title: "This deployment does not offer that",
    action:
      "The control plane does not implement what was asked for, so nothing was created. Trace and video capture are the usual cause at this stage; ask the operator which capabilities this build carries.",
  },
  PUBLISHED_SERVICE_UNAVAILABLE: {
    title: "This deployment no longer carries that route",
    action:
      "The route was revoked, expired, or was never carried, so a session started against it would reach nothing. Publish the development service again, then start the session.",
  },
  CONNECTOR_OFFLINE: {
    title: "The tunnel is unavailable",
    action:
      "The connector holds no channel to this control plane, so nothing carries the route this session would reach the application through. A connector that stopped reporting usually dials back in on its own; check the environment, then start the session again.",
  },
};

/**
 * One title and one action for every stable code the project event stream can
 * meet (`docs/API.md` section 18.1, `docs/EVENTS.md` section 10).
 *
 * The channel refuses in two places and the reader cannot tell them apart, so
 * the wording must hold for both: before the upgrade, as an HTTP status on the
 * handshake, and after it, as a `stream.error` on an open subscription.
 *
 * `RESOURCE_NOT_FOUND` is the one that carries the weight here. `docs/EVENTS.md`
 * section 10 requires a project outside the subscriber's scope to be refused
 * exactly as an unknown identifier is, so that a refusal cannot be used to
 * discover that another organisation's project exists. The shared wording leaves
 * that ambiguity intact, and this surface must not resolve it.
 *
 * There is no entry that says the history is gone. A refusal on this channel
 * stops live delivery and never the record: `GET /api/v1/projects/:projectId/activity`
 * still answers, which is why each action below sends the reader to the page
 * rather than to an administrator.
 */
export const EVENT_STREAM_REFUSALS: RefusalTable = {
  ...SHARED_REFUSALS,
  AUTHENTICATION_REQUIRED: {
    title: "Your session has expired",
    action:
      "The event stream closed because this browser is no longer signed in. Sign in again; the history is unaffected and is read again when you do.",
  },
  AUTHORISATION_DENIED: {
    title: "This origin may not open an event stream",
    action:
      "The control plane accepts event subscriptions only from the addresses its administrator configured. Open ReviewPlane at its configured address rather than through another host or proxy.",
  },
  RATE_LIMITED: {
    title: "Too many subscriptions from this session",
    action:
      "Close another ReviewPlane tab watching this project, or wait a moment. Nothing is lost: the history below is read from the durable record, not from the stream.",
  },
  UNSUPPORTED_CAPABILITY: {
    title: "The control plane refused this subscription",
    action:
      "This build of the web application and the control plane do not agree on the event channel. The history below is still read over HTTP; ask the operator to check that both were upgraded together.",
  },
  VALIDATION_FAILED: {
    title: "The subscription request was refused",
    action:
      "The control plane rejected the position this view asked to resume from. Reload the page to start again from the current record.",
  },
  INTERNAL_ERROR: {
    title: "The event stream is unavailable",
    action:
      "The control plane could not serve live events. The history below is read from the durable record and is complete up to the moment it was read; reload to read it again.",
  },
};

/**
 * The refusal, by its stable code (`docs/UX_FLOWS.md` section 18). An
 * unrecognised code is still named rather than flattened into "something went
 * wrong": a reader can act on a code, and can quote it.
 */
export function explain(table: RefusalTable, code: string, message: string): Explanation {
  return table[code] ?? { title: code, action: message };
}

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

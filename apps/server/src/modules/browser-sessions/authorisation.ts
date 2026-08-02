/**
 * The browser-command authorisation matrix (`docs/SECURITY.md` section 7,
 * ADR-0007, ADR-0028).
 *
 * `docs/SECURITY.md` section 7 lists six checks that must pass before a command
 * reaches Chromium:
 *
 *   1. the browser session belongs to the actor's project;
 *   2. the session is active;
 *   3. the actor owns the current control lease, or the command is a
 *      non-interactive system capture;
 *   4. the control epoch matches;
 *   5. the command is permitted by policy;
 *   6. the target route is associated with the session.
 *
 * They are pure functions here, taking a decided state rather than a database,
 * so the matrix can be exercised without a browser or a worker and so the
 * command path cannot skip one by forgetting an `if`. `service.ts` gathers the
 * facts; this decides.
 *
 * **The epoch is compared before lease ownership**, which is the reverse of the
 * order the list above is written in. Both refuse the same commands; the
 * difference is only which refusal a superseded controller is told, and a
 * controller whose lease was taken away holds a stale epoch *and* no lease. Of
 * the two answers, `CONTROL_EPOCH_STALE` carries the epoch that is current and
 * so tells the caller what to do next, while `CONTROL_NOT_OWNED` does not. It
 * is also the order the worker applies (`apps/browser-worker/src/session/
 * control.ts`), and two layers that disagreed about which refusal a stale
 * command earns would make the audit record depend on which layer caught it.
 * `docs/SECURITY.md` section 7 records the ordering and this reason.
 */

import {
  INTERACTIVE_COMMANDS,
  SYSTEM_CAPTURE_COMMANDS,
  type BrowserCommand,
  type CommandName,
  type ControllerIdentity,
  type SessionStatus,
} from "@reviewplane/protocol/browser";

/**
 * A refusal, in the vocabulary `docs/MCP_SPEC.md` section 12 fixes.
 *
 * Its `details` use the member names
 * `packages/protocol/schemas/mcp/v1.schema.json` `$defs.error_details`
 * declares.
 *
 * The names matter because that object is closed: a member the schema does not
 * declare is dropped on the way to an agent rather than delivered, so a detail
 * set here under a different name is a detail nobody receives. `status` was
 * that member until RVP-30 — and `status` in a refusal that may concern a
 * review, a finding or a browser session says nothing about which, so the
 * schema names it `browser_session_status` and this does too.
 */
export interface CommandDenial {
  readonly code:
    | "RESOURCE_NOT_FOUND"
    | "BROWSER_SESSION_NOT_ACTIVE"
    | "CONTROL_EPOCH_STALE"
    | "CONTROL_NOT_OWNED"
    | "POLICY_DENIED"
    | "AUTHORISATION_DENIED";
  readonly message: string;
  readonly details?: Record<string, unknown>;
  /** What `browser.command_rejected` records as the reason. */
  readonly reason: string;
}

/** Everything the matrix needs to know, gathered by the caller. */
export interface CommandContext {
  /** Project the browser session belongs to. */
  readonly sessionProjectId: string;
  /** Project the actor is scoped to. */
  readonly actorProjectId: string;
  readonly status: SessionStatus;
  readonly currentEpoch: number;
  readonly currentController: ControllerIdentity | null;
  readonly presentedEpoch: number;
  readonly presentedController: ControllerIdentity;
  /** The session's published service, when it has one. */
  readonly publishedServiceId: string | null;
  /**
   * Whether that published service is still a live route naming this session.
   * `null` when the session has no route at all, which is not a fault: a
   * session with no published service can reach nothing, and a command that
   * does not touch the network is unaffected by that.
   */
  readonly routeAssociated: boolean | null;
}

const INTERACTIVE = new Set<string>(INTERACTIVE_COMMANDS);
const SYSTEM_CAPTURE = new Set<string>(SYSTEM_CAPTURE_COMMANDS);

export function isInteractive(command: CommandName): boolean {
  return INTERACTIVE.has(command);
}

export function isSystemCapture(command: CommandName): boolean {
  return SYSTEM_CAPTURE.has(command);
}

/** Commands that make the browser fetch something over the session's route. */
function reachesTheNetwork(command: CommandName): boolean {
  return command === "navigate";
}

function sameController(left: ControllerIdentity, right: ControllerIdentity | null): boolean {
  return right !== null && left.type === right.type && left.id === right.id;
}

/**
 * Text a browser command MUST NOT carry, because it is secret material
 * (`docs/MCP_SPEC.md` section 7.4, `docs/SECURITY.md` section 12).
 *
 * Stage 1 has no secret store and no injection tool, so there is no supported
 * way to type a credential into a page — which makes "do not put one here" a
 * rule with no escape hatch rather than a preference. The detection is on
 * shape, and shape is a heuristic: this catches the forms a credential actually
 * arrives in — a `reviewplane` agent token, a bearer header pasted whole, a
 * PEM block, a `key=value` pair whose key names a secret — and cannot catch a
 * password that looks like a word. It is a guard rail on the documented rule,
 * not a substitute for it, and `docs/SECURITY.md` section 12 says so.
 */
const SECRET_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "reviewplane_agent_token", pattern: /\brpa_[A-Za-z0-9_-]{16,}/u },
  { name: "authorization_header", pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/iu },
  { name: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  {
    name: "named_secret_assignment",
    pattern:
      /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential)\b\s*[:=]\s*\S{6,}/iu,
  },
  { name: "aws_access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/u },
];

/** The name of the shape a value matched, or null. */
export function secretMaterialShape(value: string): string | null {
  for (const shape of SECRET_SHAPES) {
    if (shape.pattern.test(value)) return shape.name;
  }
  return null;
}

/**
 * Applies the matrix and returns the refusal, or `null` when the command may
 * be sent to the worker.
 */
export function authoriseBrowserCommand(
  context: CommandContext,
  command: BrowserCommand,
): CommandDenial | null {
  // 1. Project. A session in another project is *not found* rather than
  //    forbidden: a distinct refusal would confirm the identifier exists,
  //    which is the enumeration a cross-project caller wants
  //    (`docs/API.md` section 5, `docs/SECURITY.md` section 7).
  if (context.sessionProjectId !== context.actorProjectId) {
    return {
      code: "RESOURCE_NOT_FOUND",
      message: "The browser session was not found.",
      reason: "project_mismatch",
    };
  }

  // 2. Session state. PAUSED is not simply "not active": `docs/MCP_SPEC.md`
  //    section 7.3 says a pause suspends agent-issued *interactive* commands
  //    and that non-interactive system capture may continue, so the state check
  //    and the interactivity of the command are decided together.
  if (context.status === "PAUSED") {
    if (isInteractive(command.command)) {
      return {
        code: "BROWSER_SESSION_NOT_ACTIVE",
        message:
          "The browser session is paused. Resume it before issuing interactive commands; capture continues while paused.",
        details: { browser_session_status: context.status },
        reason: "session_paused",
      };
    }
  } else if (context.status !== "READY" && context.status !== "ACTIVE") {
    return {
      code: "BROWSER_SESSION_NOT_ACTIVE",
      message: `The browser session is ${context.status}.`,
      details: { browser_session_status: context.status },
      reason: "session_not_active",
    };
  }

  // 3. Epoch — see the header for why this precedes lease ownership.
  if (context.presentedEpoch !== context.currentEpoch) {
    return {
      code: "CONTROL_EPOCH_STALE",
      message: "Browser control changed. Refresh session state before retrying.",
      details: { current_epoch: context.currentEpoch },
      reason: "control_epoch_stale",
    };
  }

  // 4. Lease ownership, or a non-interactive system capture. A system capture
  //    never transfers or revokes the interactive lease
  //    (`docs/TESTING.md` section 5).
  if (!sameController(context.presentedController, context.currentController)) {
    const systemCapture =
      isSystemCapture(command.command) && context.presentedController.type === "system";
    if (!systemCapture) {
      return {
        code: "CONTROL_NOT_OWNED",
        message: "Another controller holds the interactive lease for this browser session.",
        details: { current_epoch: context.currentEpoch },
        reason: "control_not_owned",
      };
    }
  }

  // 5. Policy.
  const policy = policyDenial(command);
  if (policy !== null) return policy;

  // 6. Route association. A navigation is the command that makes the browser
  //    fetch over the session's route, so it is the one that must not run
  //    against a route that has been revoked, has expired, or no longer names
  //    this session. The worker refuses an origin outside the session's own as
  //    well; this refuses the case where the route the origin *belongs* to has
  //    stopped authorising the session, which the worker cannot see because its
  //    egress policy was fixed when its context was created.
  if (reachesTheNetwork(command.command) && context.routeAssociated === false) {
    return {
      code: "AUTHORISATION_DENIED",
      message:
        "The published service this browser session was allocated against no longer authorises it.",
      details: { published_service_id: context.publishedServiceId },
      reason: "route_not_associated",
    };
  }

  return null;
}

/** The policy checks of step 5, separated so they can be tested alone. */
export function policyDenial(command: BrowserCommand): CommandDenial | null {
  if (command.command === "type_text") {
    const text = command.type_text?.text ?? "";
    const shape = secretMaterialShape(text);
    if (shape !== null) {
      return {
        code: "POLICY_DENIED",
        message:
          "This value looks like secret material. Secrets MUST NOT be typed into a page through browser_type (docs/MCP_SPEC.md section 7.4).",
        // The matched value is never echoed: a refusal that quoted the
        // credential would put it in the response, the log and the event
        // (`docs/SECURITY.md` section 18).
        details: { reason: "secret_material", detected: shape },
        reason: "secret_material_refused",
      };
    }
  }
  return null;
}

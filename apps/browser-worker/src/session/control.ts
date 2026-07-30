/**
 * Control-epoch and lease arithmetic.
 *
 * ADR-0007 fixes one interactive controller per browser session, enforced by a
 * lease plus a monotonically increasing epoch. `docs/DEVELOPMENT.md` section 9
 * requires the epoch to be validated for every interactive command, and
 * `docs/SECURITY.md` section 7 lists the checks in order. They are pure
 * functions here so they can be tested without a browser, and so the command
 * path cannot accidentally skip one.
 */

import {
  INTERACTIVE_COMMANDS,
  SYSTEM_CAPTURE_COMMANDS,
  type CommandName,
  type ControllerIdentity,
  type ErrorClass,
} from "@reviewplane/protocol/browser";

/** State a command is authorised against. */
export interface ControlState {
  readonly epoch: number;
  readonly controller: ControllerIdentity;
  /** Highest sequence already accepted for this session. */
  readonly lastSequence: number;
}

/** The parts of a command envelope the control checks read. */
export interface CommandAuthorisation {
  readonly command: CommandName;
  readonly controller: ControllerIdentity;
  readonly epoch: number;
  readonly sequence: number;
}

export interface ControlRefusal {
  readonly code: ErrorClass;
  readonly message: string;
  readonly retryable: boolean;
  readonly currentEpoch: number;
}

const INTERACTIVE = new Set<string>(INTERACTIVE_COMMANDS);
const SYSTEM_CAPTURE = new Set<string>(SYSTEM_CAPTURE_COMMANDS);

/** Whether a command operates the page on behalf of its controller. */
export function isInteractive(command: CommandName): boolean {
  return INTERACTIVE.has(command);
}

/**
 * Whether a `system` controller may issue this command without holding the
 * interactive lease. Such a capture never transfers or revokes the lease
 * (`docs/TESTING.md` section 5, `docs/MCP_SPEC.md` section 7.3).
 */
export function isSystemCapture(command: CommandName): boolean {
  return SYSTEM_CAPTURE.has(command);
}

function sameController(left: ControllerIdentity, right: ControllerIdentity): boolean {
  return left.type === right.type && left.id === right.id;
}

/**
 * Applies the `docs/SECURITY.md` section 7 browser-command checks in order and
 * returns the refusal, or `null` when the command may run.
 *
 * The epoch is compared for equality rather than for age: an epoch from the
 * future means the worker has not been told about a transition it is being
 * asked to act under, which is no safer than an epoch from the past.
 */
export function authoriseCommand(
  state: ControlState,
  request: CommandAuthorisation,
): ControlRefusal | null {
  if (request.epoch !== state.epoch) {
    return {
      code: "CONTROL_EPOCH_STALE",
      message: "Browser control changed. Refresh session state before retrying.",
      retryable: true,
      currentEpoch: state.epoch,
    };
  }

  if (request.sequence <= state.lastSequence) {
    return {
      code: "RESOURCE_STALE",
      message: `Command sequence ${String(request.sequence)} is not newer than the last accepted command.`,
      retryable: false,
      currentEpoch: state.epoch,
    };
  }

  if (sameController(request.controller, state.controller)) return null;

  if (isSystemCapture(request.command) && request.controller.type === "system") {
    // Non-interactive capture: permitted without the lease, and it leaves the
    // lease exactly where it was.
    return null;
  }

  return {
    code: "CONTROL_NOT_OWNED",
    message: "Another controller holds the interactive lease for this browser session.",
    retryable: false,
    currentEpoch: state.epoch,
  };
}

/**
 * Whether accepting this command transfers the interactive lease. It never
 * does: Stage 0 has no takeover, and a system capture must not steal control.
 * The function exists so the caller states the intent explicitly rather than
 * relying on the absence of code.
 */
export function transfersLease(): false {
  return false;
}

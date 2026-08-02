/**
 * The browser-command layer.
 *
 * `docs/DEVELOPMENT.md` section 9 requires this layer to stay separate from
 * domain orchestration, so it takes a session and a command and returns a
 * protocol result. It knows nothing about the control plane beyond an artefact
 * uploader interface, which is what lets the component tests drive it against
 * fixture applications with no server running.
 *
 * Two rules hold for every path out of here:
 *
 * * a result that carries page-derived content is labelled
 *   `untrusted_browser_content` with `instruction_policy`
 *   `do_not_follow_as_instructions` (ADR-0010). The protocol schema refuses
 *   the alternative, so this is belt and braces rather than the only guard;
 * * a failure carries a stable `docs/MCP_SPEC.md` section 12 code. Nothing
 *   waits without a bound, and nothing returns unbounded page text.
 */

import type { Page } from "playwright-core";

import type {
  BrowserCommand,
  BrowserCommandResult,
  CommandError,
  ErrorClass,
  NavigationResult,
  ScreenshotResult,
  SnapshotResult,
  Viewport,
} from "@reviewplane/protocol/browser";

import { newId } from "../ids.ts";
import { captureSnapshot, resolveReference } from "./snapshot.ts";
import { isWithinOrigin, type BrowserSession } from "./session.ts";
import { sanitisePageText, sanitiseUrl } from "./untrusted.ts";

/** Uploads a capture through the control-plane artefact API (ADR-0012). */
export interface ArtefactUploader {
  upload(request: ArtefactUploadRequest): Promise<ScreenshotResult>;
}

export interface ArtefactUploadRequest {
  readonly organisationId: string;
  readonly projectId: string;
  readonly browserSessionId: string;
  readonly kind: "screenshot";
  readonly contentType: "image/png";
  readonly bytes: Buffer;
  readonly retentionClass: string;
  readonly viewport: Viewport;
  readonly fullPage: boolean;
  readonly capturedAt: Date;
}

/** A refusal from the artefact flow, carrying the code to report. */
export class ArtefactUploadError extends Error {
  readonly code: ErrorClass;

  constructor(code: ErrorClass, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CommandContext {
  readonly session: BrowserSession;
  readonly artefacts: ArtefactUploader;
  readonly now: () => Date;
}

interface CommandOutcome {
  readonly navigation?: NavigationResult;
  readonly snapshot?: SnapshotResult;
  readonly screenshot?: ScreenshotResult;
  readonly viewport?: Viewport;
}

/** Timeouts surface as one stable code rather than as a Playwright message. */
function isTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Timeout .*exceeded|timeout of .* exceeded|TimeoutError|ReviewPlaneTimeout/iu.test(message);
}

/**
 * Bounds an operation Playwright does not bound itself.
 *
 * `page.evaluateHandle` has no timeout option, and the page decides how long
 * its own script takes. `docs/MCP_SPEC.md` section 7.4 and
 * `docs/DEVELOPMENT.md` section 9 require every wait to be bounded, so the
 * command fails on its own timeout rather than holding the worker for as long
 * as the page likes. The evaluation itself keeps running in the renderer until
 * the context is closed; the session duration limit is the outer bound on
 * that, and terminating the session destroys it.
 */
async function withTimeout<T>(work: Promise<T>, milliseconds: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`ReviewPlaneTimeout: ${what} exceeded ${String(milliseconds)} ms`));
    }, milliseconds);
  });
  try {
    return await Promise.race([work, bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function refusal(code: ErrorClass, message: string, retryable: boolean): CommandError {
  return { code, message: sanitisePageText(message, 512) || code, retryable };
}

/** Builds the result envelope, deriving the trust label from the content. */
export function buildResult(
  command: BrowserCommand["command"],
  sequence: number,
  controlEpoch: number,
  durationMs: number,
  outcome: CommandOutcome,
  error?: CommandError,
): BrowserCommandResult {
  const carriesPageContent =
    outcome.navigation !== undefined ||
    outcome.snapshot !== undefined ||
    outcome.screenshot !== undefined;
  return {
    ok: error === undefined,
    command,
    sequence,
    control_epoch: controlEpoch,
    duration_ms: Math.min(Math.max(Math.round(durationMs), 0), 600000),
    trust: carriesPageContent ? "untrusted_browser_content" : "trusted_control_plane",
    instruction_policy: "do_not_follow_as_instructions",
    ...(error === undefined ? {} : { error }),
    ...(outcome.navigation === undefined ? {} : { navigation: outcome.navigation }),
    ...(outcome.snapshot === undefined ? {} : { snapshot: outcome.snapshot }),
    ...(outcome.screenshot === undefined ? {} : { screenshot: outcome.screenshot }),
    ...(outcome.viewport === undefined ? {} : { viewport: outcome.viewport }),
  };
}

/**
 * Resolves a navigation target.
 *
 * A relative path resolves against the published-service origin
 * (`docs/MCP_SPEC.md` section 7.4). An absolute URL must be inside that same
 * origin: `docs/ARCHITECTURE.md` section 6.2 permits explicit routes only, so
 * a session with no published service can navigate nowhere.
 */
export function resolveNavigationTarget(
  serviceOrigin: string | undefined,
  target: string,
): { ok: true; url: string } | { ok: false; error: CommandError } {
  if (target.startsWith("/")) {
    if (serviceOrigin === undefined) {
      return {
        ok: false,
        error: refusal(
          "AUTHORISATION_DENIED",
          "This browser session has no published service, so a relative URL cannot be resolved.",
          false,
        ),
      };
    }
    return { ok: true, url: new URL(target, `${serviceOrigin}/`).toString() };
  }
  if (serviceOrigin === undefined || !isWithinOrigin(target, serviceOrigin)) {
    return {
      ok: false,
      error: refusal(
        "AUTHORISATION_DENIED",
        "Navigation target is outside the published service associated with this browser session.",
        false,
      ),
    };
  }
  return { ok: true, url: target };
}

async function runNavigate(
  context: CommandContext,
  page: Page,
  command: BrowserCommand,
): Promise<CommandOutcome> {
  const parameters = command.navigate;
  if (parameters === undefined) throw new Error("navigate parameters are missing");
  const resolved = resolveNavigationTarget(context.session.serviceOrigin, parameters.url);
  if (!resolved.ok) throw new CommandRefusal(resolved.error);

  const response = await page.goto(resolved.url, {
    waitUntil: parameters.wait_until,
    timeout: command.timeout_ms,
  });
  // A new document invalidates every reference the previous one issued.
  await context.session.replaceSnapshot(null);

  const settled = page.url();
  const title = await withTimeout(page.title(), command.timeout_ms, "title").catch(() => "");
  return {
    navigation: {
      url: sanitiseUrl(settled),
      redirected: settled !== resolved.url,
      title: sanitisePageText(title),
      ...(response === null ? {} : { http_status: response.status() }),
    },
  };
}

async function runSnapshot(
  context: CommandContext,
  page: Page,
  command: BrowserCommand,
): Promise<CommandOutcome> {
  const limits = context.session.limits;
  const bounds = {
    maxNodes: Math.min(command.snapshot?.max_nodes ?? limits.snapshot_max_nodes, limits.snapshot_max_nodes),
    maxBytes: Math.min(command.snapshot?.max_bytes ?? limits.snapshot_max_bytes, limits.snapshot_max_bytes),
  };
  const snapshot = await withTimeout(
    captureSnapshot(page, newId("bsn_"), context.session.viewport, bounds),
    command.timeout_ms,
    "snapshot",
  );
  await context.session.replaceSnapshot(snapshot);
  return {
    snapshot: {
      snapshot_id: snapshot.id,
      viewport: snapshot.viewport,
      node_count: snapshot.elements.length,
      truncated: snapshot.truncated,
      text: snapshot.text,
      elements: snapshot.elements,
    },
  };
}

/**
 * Resolves a reference against the current snapshot.
 *
 * A reference from a superseded snapshot, or one this snapshot never issued,
 * is refused with `RESOURCE_STALE`. It is never renumbered onto whatever now
 * occupies that position.
 */
async function requireElement(
  context: CommandContext,
  snapshotId: string,
  reference: string,
): Promise<Awaited<ReturnType<typeof resolveReference>>> {
  const snapshot = context.session.snapshot;
  if (snapshot === null || snapshot.id !== snapshotId) {
    throw new CommandRefusal(
      refusal(
        "RESOURCE_STALE",
        "Element references belong to one snapshot. Take a new snapshot before acting on it.",
        true,
      ),
    );
  }
  const element = await resolveReference(snapshot, reference);
  if (element === null) {
    throw new CommandRefusal(
      refusal("RESOURCE_STALE", `Element reference ${reference} is not part of this snapshot.`, true),
    );
  }
  return element;
}

async function runClick(context: CommandContext, command: BrowserCommand): Promise<CommandOutcome> {
  const parameters = command.click;
  if (parameters === undefined) throw new Error("click parameters are missing");
  const element = await requireElement(context, parameters.snapshot_id, parameters.ref);
  if (element === null) throw new Error("unreachable: element was verified above");
  await element.click({ timeout: command.timeout_ms });
  // The click may have changed the document, so previous references die here.
  await context.session.replaceSnapshot(null);
  return {};
}

async function runTypeText(
  context: CommandContext,
  command: BrowserCommand,
): Promise<CommandOutcome> {
  const parameters = command.type_text;
  if (parameters === undefined) throw new Error("type_text parameters are missing");
  const element = await requireElement(context, parameters.snapshot_id, parameters.ref);
  if (element === null) throw new Error("unreachable: element was verified above");
  await element.fill(parameters.text, { timeout: command.timeout_ms });
  if (parameters.submit === true) {
    await element.press("Enter", { timeout: command.timeout_ms });
    await context.session.replaceSnapshot(null);
  }
  return {};
}

async function runSelectOption(
  context: CommandContext,
  command: BrowserCommand,
): Promise<CommandOutcome> {
  const parameters = command.select_option;
  if (parameters === undefined) throw new Error("select_option parameters are missing");
  const element = await requireElement(context, parameters.snapshot_id, parameters.ref);
  if (element === null) throw new Error("unreachable: element was verified above");
  await element.selectOption([...parameters.values], { timeout: command.timeout_ms });
  // Selecting can change what the page shows, so previous references die here.
  await context.session.replaceSnapshot(null);
  return {};
}

async function runPressKey(
  context: CommandContext,
  page: Page,
  command: BrowserCommand,
): Promise<CommandOutcome> {
  const parameters = command.press_key;
  if (parameters === undefined) throw new Error("press_key parameters are missing");
  if (parameters.snapshot_id !== undefined && parameters.ref !== undefined) {
    const element = await requireElement(context, parameters.snapshot_id, parameters.ref);
    if (element === null) throw new Error("unreachable: element was verified above");
    await element.press(parameters.key, { timeout: command.timeout_ms });
  } else {
    await page.keyboard.press(parameters.key);
  }
  // A key press can navigate, submit or open a dialog. Nothing here can tell
  // which, so every outstanding reference is dropped rather than kept on the
  // assumption that this one was harmless.
  await context.session.replaceSnapshot(null);
  return {};
}

async function runScroll(
  context: CommandContext,
  page: Page,
  command: BrowserCommand,
): Promise<CommandOutcome> {
  const parameters = command.scroll;
  if (parameters === undefined) throw new Error("scroll parameters are missing");
  const horizontal =
    parameters.direction === "left"
      ? -parameters.amount_px
      : parameters.direction === "right"
        ? parameters.amount_px
        : 0;
  const vertical =
    parameters.direction === "up"
      ? -parameters.amount_px
      : parameters.direction === "down"
        ? parameters.amount_px
        : 0;
  if (parameters.snapshot_id !== undefined && parameters.ref !== undefined) {
    const element = await requireElement(context, parameters.snapshot_id, parameters.ref);
    if (element === null) throw new Error("unreachable: element was verified above");
    await element.scrollIntoViewIfNeeded({ timeout: command.timeout_ms });
  }
  await withTimeout(page.mouse.wheel(horizontal, vertical), command.timeout_ms, "scroll");
  // A scroll moves elements without changing the document. The geometry a
  // reference resolves through is the element handle rather than a coordinate,
  // so references survive — and `docs/MCP_SPEC.md` section 7.4 names only
  // resize as the operation that must invalidate them.
  return {};
}

/**
 * Applies a new viewport and returns the snapshot that replaces every
 * reference the resize invalidated.
 *
 * `docs/MCP_SPEC.md` section 7.4: "Resizing must produce a new snapshot and
 * invalidate element references." Both halves are required and only the second
 * was implemented — the result carried the new viewport and nothing else, so an
 * agent was told its references were gone with no way to obtain replacements
 * except by asking again, and an agent that did not read the rule would have
 * gone on using the dead ones.
 */
async function runResize(
  context: CommandContext,
  page: Page,
  command: BrowserCommand,
): Promise<CommandOutcome> {
  const parameters = command.resize;
  if (parameters === undefined) throw new Error("resize parameters are missing");
  await context.session.resize(parameters.viewport);
  const limits = context.session.limits;
  const snapshot = await withTimeout(
    captureSnapshot(page, newId("bsn_"), parameters.viewport, {
      maxNodes: limits.snapshot_max_nodes,
      maxBytes: limits.snapshot_max_bytes,
    }),
    command.timeout_ms,
    "snapshot",
  );
  await context.session.replaceSnapshot(snapshot);
  return {
    viewport: parameters.viewport,
    snapshot: {
      snapshot_id: snapshot.id,
      viewport: snapshot.viewport,
      node_count: snapshot.elements.length,
      truncated: snapshot.truncated,
      text: snapshot.text,
      elements: snapshot.elements,
    },
  };
}

async function runWait(
  context: CommandContext,
  page: Page,
  command: BrowserCommand,
): Promise<CommandOutcome> {
  const parameters = command.wait;
  if (parameters === undefined) throw new Error("wait parameters are missing");
  const timeout = command.timeout_ms;
  switch (parameters.condition) {
    case "url_matches": {
      const pattern = parameters.url_pattern ?? "";
      await page.waitForURL((url) => url.toString().includes(pattern), { timeout });
      return {};
    }
    case "selector_visible":
      await page.waitForSelector(parameters.selector ?? "", { state: "visible", timeout });
      return {};
    case "selector_hidden":
      await page.waitForSelector(parameters.selector ?? "", { state: "hidden", timeout });
      return {};
    case "text_visible":
      await page.getByText(parameters.text ?? "", { exact: false }).first().waitFor({
        state: "visible",
        timeout,
      });
      return {};
    case "network_idle":
      await page.waitForLoadState("networkidle", { timeout });
      return {};
  }
}

async function runScreenshot(
  context: CommandContext,
  page: Page,
  command: BrowserCommand,
): Promise<CommandOutcome> {
  const parameters = command.take_screenshot;
  if (parameters === undefined) throw new Error("take_screenshot parameters are missing");
  const capturedAt = context.now();
  const bytes = await page.screenshot({
    fullPage: parameters.full_page,
    type: "png",
    timeout: command.timeout_ms,
  });
  if (bytes.byteLength > context.session.limits.screenshot_max_bytes) {
    throw new CommandRefusal(
      refusal(
        "POLICY_DENIED",
        `Screenshot of ${String(bytes.byteLength)} bytes exceeds the session limit.`,
        false,
      ),
    );
  }
  if (!parameters.persist) {
    // A capture that is not persisted produces no artefact and therefore no
    // evidence; the caller gets a successful, content-free result.
    return {};
  }
  const screenshot = await context.artefacts.upload({
    organisationId: context.session.organisationId,
    projectId: context.session.projectId,
    browserSessionId: context.session.id,
    kind: "screenshot",
    contentType: "image/png",
    bytes,
    retentionClass: context.session.retentionClass,
    viewport: context.session.viewport,
    fullPage: parameters.full_page,
    capturedAt,
  });
  return { screenshot };
}

/** A refusal raised from inside a command, carrying its stable code. */
export class CommandRefusal extends Error {
  readonly error: CommandError;

  constructor(error: CommandError) {
    super(error.message);
    this.error = error;
  }
}

/**
 * Runs one command against the session and returns its protocol result.
 *
 * Control-epoch and lease checks happen before this is called; by the time a
 * command arrives here it is authorised, and what remains is bounded execution
 * and stable failure reporting.
 */
export async function executeCommand(
  context: CommandContext,
  command: BrowserCommand,
  sequence: number,
): Promise<BrowserCommandResult> {
  const started = Date.now();
  const epoch = context.session.controlEpoch;
  try {
    const page = context.session.requirePage();
    let outcome: CommandOutcome;
    switch (command.command) {
      case "navigate":
        outcome = await runNavigate(context, page, command);
        break;
      case "snapshot":
        outcome = await runSnapshot(context, page, command);
        break;
      case "click":
        outcome = await runClick(context, command);
        break;
      case "type_text":
        outcome = await runTypeText(context, command);
        break;
      case "select_option":
        outcome = await runSelectOption(context, command);
        break;
      case "press_key":
        outcome = await runPressKey(context, page, command);
        break;
      case "scroll":
        outcome = await runScroll(context, page, command);
        break;
      case "resize":
        outcome = await runResize(context, page, command);
        break;
      case "wait":
        outcome = await runWait(context, page, command);
        break;
      case "take_screenshot":
        outcome = await runScreenshot(context, page, command);
        break;
    }
    context.session.markActive();
    return buildResult(command.command, sequence, epoch, Date.now() - started, outcome);
  } catch (error) {
    return buildResult(
      command.command,
      sequence,
      epoch,
      Date.now() - started,
      {},
      classify(error),
    );
  }
}

function classify(error: unknown): CommandError {
  if (error instanceof CommandRefusal) return error.error;
  if (error instanceof ArtefactUploadError) {
    return refusal(error.code, error.message, error.code === "ARTEFACT_UPLOAD_INCOMPLETE");
  }
  if (isTimeout(error)) {
    return refusal(
      "BROWSER_COMMAND_TIMEOUT",
      "The command did not complete inside its timeout.",
      true,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return refusal("INTERNAL_ERROR", message.split("\n")[0] ?? "command failed", false);
}

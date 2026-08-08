/**
 * The agent fixture: steps 9 to 12 of the scenario in `docs/TESTING.md` §3.
 *
 * It stands in for a CLI coding agent on the development machine, and it runs
 * *on* that machine — inside the `dev-fixture` container — because that is what
 * makes it the agent rather than a script pretending to be one. It speaks MCP
 * as a real client and calls no internal API.
 *
 * Two MCP sessions, and the difference between them is the point.
 *
 *   * **The local stdio bridge** (`docs/MCP_SPEC.md` §3.1). It spawns
 *     `reviewplane-connector mcp` and speaks newline-delimited JSON-RPC over its
 *     stdin and stdout, which is exactly the transport an MCP client's stdio
 *     transport speaks. The bridge exchanges this environment's X.509 device
 *     identity for a short-lived agent credential over the mutually
 *     authenticated connector listener (ADR-0023) and resolves the project from
 *     the working directory, so credential exchange and project resolution are
 *     exercised rather than bypassed. Every review, finding and verification
 *     call goes over this session.
 *
 *   * **The remote HTTP endpoint** (§3.2), with an administrator-issued agent
 *     credential the harness passes in. This exists because a bridge credential
 *     carries the workflow capabilities and **no browser capability** at all
 *     (`apps/server/src/modules/connectors/agent-credentials.ts`,
 *     `BRIDGE_CAPABILITIES`; `docs/SECURITY.md` §6.3), so an agent on the bridge
 *     cannot capture the after screenshot that
 *     `finding_submit_verification` then requires. Both sessions reach the same
 *     `/mcp/v1` endpoint and both are real MCP clients; only the credential
 *     differs. See the note in `deploy/compose/e2e/run.sh` at step 11.
 *
 * It writes a JSON report to stdout and nothing else. Diagnostics go to stderr,
 * because stdout is what the harness parses. **No credential is ever written to
 * either**: the bridge's token never leaves the bridge process, and the token
 * this script is handed is used and never printed.
 *
 * Usage:
 *   node agent-fixture.mjs
 * Environment:
 *   RP_REVIEW_SLUG      the named review to work (default bugs-on-homepage)
 *   RP_WORKSPACE_ID     the workspace to publish from
 *   RP_CHECKOUT         the checkout path on this machine
 *   RP_MCP_URL          the §3.2 endpoint, for the browser session
 *   RP_BROWSER_TOKEN    the administrator-issued agent credential
 *   RP_PROJECT_HINT     project slug for the §3.2 session
 *   RP_INBOX_TIMEOUT_MS how long to wait for the assignment (default 180000)
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const run = promisify(execFile);

const REVIEW_SLUG = process.env.RP_REVIEW_SLUG ?? "bugs-on-homepage";
const WORKSPACE_ID = process.env.RP_WORKSPACE_ID ?? "wsp_fixture";
const CHECKOUT = process.env.RP_CHECKOUT ?? "/opt/reviewplane/dev-fixture";
const MCP_URL = process.env.RP_MCP_URL ?? "";
const BROWSER_TOKEN = process.env.RP_BROWSER_TOKEN ?? "";
const PROJECT_HINT = process.env.RP_PROJECT_HINT ?? "";
const INBOX_TIMEOUT_MS = Number(process.env.RP_INBOX_TIMEOUT_MS ?? "180000");

/**
 * The two viewports `AGENTS.md` requires UI-facing work to be checked at.
 *
 * They are sent whole wherever a viewport is asked for, including
 * `tested_viewports`: `viewport` requires `device_scale_factor` as well as the
 * two extents, so a pair stripped to `{width, height}` is refused by the
 * schema, and the ratio is part of what "tested at this viewport" means — a
 * screenshot at 390x844 says nothing about the same page at scale 2.
 */
const VIEWPORTS = [
  { width: 1440, height: 900, device_scale_factor: 1 },
  { width: 390, height: 844, device_scale_factor: 2 },
];

/** The marker the agent's fix puts on the page, and the evidence it produces. */
const FIXED_HEADING = "Loopback dev fixture (resolved by the agent)";

const report = { steps: [], warnings: [] };
let keyCounter = 0;

function note(message) {
  process.stderr.write(`agent-fixture: ${message}\n`);
}

function step(name, detail) {
  report.steps.push({ name, ...detail });
  note(`${name}: ${JSON.stringify(detail)}`);
}

function fail(message) {
  const error = new Error(message);
  error.fixture = true;
  throw error;
}

/** A fresh idempotency key. Every write tool requires one. */
function key(label) {
  keyCounter += 1;
  return `rvp95-${label}-${String(keyCounter)}`;
}

/**
 * Unwraps a tool result into the response envelope of `docs/MCP_SPEC.md` §5.
 *
 * A refusal is a successful JSON-RPC call carrying `ok: false`, so the envelope
 * is returned either way and the caller decides. Conflating the two would make
 * every deliberate refusal in this fixture look like a transport failure.
 */
function envelopeOf(result, tool) {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) fail(`${tool}: the result carried no content`);
  const text = blocks.find((block) => block.type === "text")?.text;
  if (text === undefined) fail(`${tool}: the result carried no text block`);
  return JSON.parse(text);
}

/**
 * The MCP client both sessions share.
 *
 * It performs the real handshake — `initialize`, then the `notifications/
 * initialized` notification — before any tool call, because a server that has
 * not seen it is entitled to refuse one. The transports differ below it and
 * nothing above it knows which is in use.
 */
class McpClient {
  #transport;
  #nextId = 1;
  #lastTrust = null;

  constructor(transport) {
    this.#transport = transport;
  }

  /**
   * The trust label of the most recent tool response.
   *
   * It lives on the envelope and not in the payload (`docs/MCP_SPEC.md` §5), so
   * a caller that only ever sees `data` cannot record it. Reading it off the
   * client is how the artefact inventory can say a screenshot was labelled
   * `trusted_control_plane` rather than record a null and call it evidence.
   */
  get lastTrust() {
    return this.#lastTrust;
  }

  async initialise(clientName) {
    const result = await this.#request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "rvp95" },
    });
    await this.#transport.notify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    return result;
  }

  async listTools() {
    const result = await this.#request("tools/list", {});
    return (result.tools ?? []).map((tool) => tool.name);
  }

  /** Calls a tool and returns its envelope, refusal or not. */
  async call(tool, args) {
    const result = await this.#request("tools/call", { name: tool, arguments: args });
    const envelope = envelopeOf(result, tool);
    this.#lastTrust = envelope.trust ?? null;
    return envelope;
  }

  /** Calls a tool and fails the run unless it succeeded. */
  async expect(tool, args) {
    const envelope = await this.call(tool, args);
    if (envelope.ok !== true) {
      fail(`${tool} was refused: ${envelope.error?.code} ${envelope.error?.message}`);
    }
    return envelope.data;
  }

  async #request(method, params) {
    const id = this.#nextId;
    this.#nextId += 1;
    const response = await this.#transport.request({ jsonrpc: "2.0", id, method, params });
    if (response.error !== undefined) {
      fail(`${method} failed below the envelope: ${JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  close() {
    this.#transport.close();
  }
}

/**
 * The stdio transport, over `reviewplane-connector mcp`.
 *
 * The bridge reads one newline-delimited JSON-RPC message from stdin, turns it
 * into one HTTP POST, and writes the response back as one line — and writes
 * *nothing* for a notification, which the control plane answers with an empty
 * body. So a notification is written and not waited for, and a request is
 * matched to the next line. Waiting for a line that is never coming is how a
 * stdio client hangs on `notifications/initialized`.
 */
class BridgeTransport {
  #child;
  #lines;
  #pending = [];
  #closed = null;

  constructor(child) {
    this.#child = child;
    this.#lines = createInterface({ input: child.stdout });
    this.#lines.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      const waiter = this.#pending.shift();
      if (waiter === undefined) {
        note(`the bridge produced an unexpected line: ${trimmed.slice(0, 200)}`);
        return;
      }
      try {
        waiter.resolve(JSON.parse(trimmed));
      } catch (error) {
        waiter.reject(new Error(`the bridge wrote a line that is not JSON: ${String(error)}`));
      }
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`  bridge| ${String(chunk).trimEnd()}\n`);
    });
    child.on("exit", (code, signal) => {
      this.#closed = `the bridge exited (code ${String(code)}, signal ${String(signal)})`;
      while (this.#pending.length > 0) {
        this.#pending.shift().reject(new Error(this.#closed));
      }
    });
  }

  async notify(message) {
    if (this.#closed !== null) fail(this.#closed);
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(message) {
    if (this.#closed !== null) fail(this.#closed);
    const settled = new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
    });
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    return settled;
  }

  close() {
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
  }
}

/**
 * The streamable-HTTP transport of `docs/MCP_SPEC.md` §3.2.
 *
 * The endpoint is configured with `enableJsonResponse`, so a POST answers with
 * one JSON body rather than an event stream. The session identifier is captured
 * from the first response and echoed on every later request, which is what makes
 * this one session; a request presenting another session's identifier with its
 * own credential is refused, so the echo is not optional.
 */
class HttpTransport {
  #url;
  #token;
  #sessionId = null;

  constructor(url, token) {
    this.#url = url;
    this.#token = token;
  }

  async notify(message) {
    await this.#post(message);
  }

  async request(message) {
    const body = await this.#post(message);
    if (body === null) fail(`${message.method}: the endpoint answered with an empty body`);
    return body;
  }

  async #post(message) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.#token}`,
    };
    if (this.#sessionId !== null) headers["mcp-session-id"] = this.#sessionId;
    const response = await fetch(this.#url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    const session = response.headers.get("mcp-session-id");
    if (session !== null && session !== "") this.#sessionId = session;
    const text = await response.text();
    if (!response.ok && text.trim() === "") {
      fail(`${message.method}: the endpoint answered ${String(response.status)}`);
    }
    if (text.trim() === "") return null;
    const parsed = JSON.parse(text);
    if (!response.ok && parsed.error !== undefined && parsed.jsonrpc === undefined) {
      // A refusal below the JSON-RPC envelope: authentication, project
      // resolution or the transport itself (`docs/MCP_SPEC.md` §3.2).
      fail(`${message.method}: ${String(response.status)} ${JSON.stringify(parsed.error)}`);
    }
    return parsed;
  }

  close() {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function git(...args) {
  const { stdout } = await run("git", ["-C", CHECKOUT, ...args], { timeout: 30_000 });
  return stdout.trim();
}

/**
 * Waits for the human's assignment to reach the agent's inbox.
 *
 * **What it proves.** `agent_inbox_list` returning an item means the control
 * plane recorded `inbox_item.created` for this agent session, which
 * `InboxStore.create` writes in the same transaction as the assignment. So the
 * item existing is the assignment having happened and having been delivered to
 * *this* session — not a proxy for it. Nothing is pushed to an agent
 * (`AGENTS.md` "Product invariant"), so polling is the mechanism rather than a
 * workaround.
 */
async function awaitAssignment(client) {
  const deadline = Date.now() + INBOX_TIMEOUT_MS;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const data = await client.expect("agent_inbox_list", { status: ["pending"], limit: 20 });
    const item = (data.items ?? []).find((entry) => entry.review_slug === REVIEW_SLUG);
    if (item !== undefined) return { item, attempts };
    await sleep(2000);
  }
  fail(
    `no inbox item for ${REVIEW_SLUG} within ${String(INBOX_TIMEOUT_MS)}ms after ${String(attempts)} polls; ` +
      "the review was never assigned to this agent session, or the assignment produced no inbox item",
  );
  return null;
}

/** The development server's entry point, as its argument vector spells it. */
const DEVELOPMENT_SERVER_ENTRY_POINT = "/static-app/src/main.ts";

/**
 * Stops the development server this environment is running, by process.
 *
 * `/proc` is read directly rather than shelling out to `pkill`, and that is not
 * a preference. This image installs `git` and `iproute2` and no `procps`
 * (`examples/dev-fixture/Dockerfile`), so `pkill` is not on PATH here — and
 * `pkill -f … || true` cannot tell "no such binary" from "no such process".
 * The consequence was silent and expensive: nothing was signalled, the
 * replacement server lost the port to the process still holding it, and
 * `/healthz` went on answering from the build the finding was raised against.
 *
 * A match is one whole argument ending in the entry point's path, so a
 * substring of some other command line cannot match, and this process's own
 * argument vector — `node /tmp/agent-fixture.mjs` — cannot either.
 *
 * Returns the identifiers it signalled, which the step record carries: an empty
 * list is the diagnosis when the wait below expires.
 */
async function stopDevelopmentServer() {
  const stopped = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let argv;
    try {
      argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
    } catch {
      continue; // it ended between the listing and the read, which is fine
    }
    if (!argv.some((argument) => argument.endsWith(DEVELOPMENT_SERVER_ENTRY_POINT))) continue;
    try {
      process.kill(pid, "SIGTERM");
      stopped.push(pid);
    } catch {
      // it ended on its own between the read and the signal
    }
  }
  return stopped;
}

/**
 * Waits for text to become visible in the browser session.
 *
 * `browser_wait` is the control plane's own bounded wait, so the bound is the
 * product's rather than this script's, and its `ok: false` is the timeout case
 * of `docs/TESTING.md` §11 rather than an exception.
 */
async function waitForText(browser, sessionId, epoch, text, timeoutMs) {
  const data = await browser.expect("browser_wait", {
    browser_session_id: sessionId,
    control_epoch: epoch,
    condition: "text_visible",
    text,
    timeout_ms: timeoutMs,
  });
  return data;
}

async function main() {
  // ---------------------------------------------------------------------
  // Step 9. The agent connects over the local bridge and claims the review.
  // ---------------------------------------------------------------------
  const child = spawn("reviewplane-connector", ["mcp"], {
    cwd: CHECKOUT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bridge = new McpClient(new BridgeTransport(child));
  const handshake = await bridge.initialise("rvp95-agent-fixture");
  step("bridge.initialised", {
    server: handshake.serverInfo?.name ?? null,
    protocol: handshake.protocolVersion ?? null,
  });

  const advertised = await bridge.listTools();
  const project = await bridge.expect("project_current", {});
  const session = await bridge.expect("agent_session_status", {});
  const agentSessionId = session.agent_session_id ?? null;
  if (agentSessionId === null) fail("agent_session_status named no agent session");
  step("bridge.session", {
    project_id: project.project?.id ?? project.id ?? null,
    project_slug: project.project?.slug ?? project.slug ?? null,
    agent_session_id: agentSessionId,
    tools_advertised: advertised.length,
  });

  // The structural half of the product invariant, read off the wire rather than
  // asserted about the source: no advertised tool can express a final
  // disposition, because the enumeration does not contain one (ADR-0020). The
  // harness asserts the behavioural half separately.
  const bridgeCannotDriveBrowser = !advertised.includes("browser_take_screenshot")
    ? "absent"
    : "advertised";

  const assignment = await awaitAssignment(bridge);
  step("inbox.delivered", {
    inbox_item_id: assignment.item.id,
    type: assignment.item.type,
    review_slug: assignment.item.review_slug,
    polls: assignment.attempts,
  });

  const acknowledged = await bridge.expect("agent_inbox_acknowledge", {
    inbox_item_id: assignment.item.id,
    idempotency_key: key("ack"),
  });
  // Acknowledgement records receipt and never completion (`docs/MCP_SPEC.md`
  // §9). Reading the completion time back is how that is asserted rather than
  // assumed.
  const completedAt = acknowledged.item?.completed_at ?? null;
  if (completedAt !== null && completedAt !== undefined) {
    fail("acknowledgement set a completion time; it records receipt only");
  }
  // A repeat under the same key must not deliver a second acknowledgement.
  const replayed = await bridge.expect("agent_inbox_acknowledge", {
    inbox_item_id: assignment.item.id,
    idempotency_key: key("ack-replay"),
  });
  step("inbox.acknowledged", {
    status: acknowledged.item?.status ?? null,
    completed_at: completedAt ?? null,
    repeat_status: replayed.item?.status ?? null,
  });

  const review = await bridge.expect("review_get", {
    review: REVIEW_SLUG,
    include: ["findings", "staleness"],
  });
  const reviewView = review.review;
  const findings = review.findings ?? [];
  if (findings.length === 0) fail(`${REVIEW_SLUG} carries no findings`);
  const finding = findings[0];
  step("review.retrieved", {
    review_id: reviewView.id,
    slug: reviewView.slug,
    status: reviewView.status,
    captured_branch: reviewView.captured_branch,
    captured_commit: reviewView.captured_commit,
    finding_count: reviewView.finding_count,
    staleness_computed: review.staleness?.computed ?? null,
    finding_id: finding.id,
    finding_source: finding.source,
    finding_status: finding.status,
    finding_screenshot_artefact_id: finding.screenshot_artefact_id,
    finding_viewport: finding.viewport,
  });

  const claimedReview = await bridge.expect("review_claim", {
    review_id: reviewView.id,
    expected_version: reviewView.version,
    idempotency_key: key("review-claim"),
  });
  const claimedFinding = await bridge.expect("finding_claim", {
    finding_id: finding.id,
    expected_version: finding.version,
    idempotency_key: key("finding-claim"),
  });
  step("claimed", {
    review_status: claimedReview.review.status,
    finding_status: claimedFinding.finding.status,
  });

  let findingVersion = claimedFinding.finding.version;
  const inProgress = await bridge.expect("finding_update_status", {
    finding_id: finding.id,
    expected_version: findingVersion,
    status: "IN_PROGRESS",
    idempotency_key: key("in-progress"),
  });
  findingVersion = inProgress.finding.version;

  // ---------------------------------------------------------------------
  // Step 10. The agent changes the application on the development machine.
  // ---------------------------------------------------------------------
  // A real edit to the checkout the connector observes, committed, and then
  // made live. The commit matters twice over: `finding_submit_verification`
  // refuses a commit equal to the one the finding was captured at — a fix
  // cannot exist at the revision the defect was recorded from — and the
  // connector reports the move as `workspace.head_changed`.
  const capturedCommit = await git("rev-parse", "HEAD");
  const pagesPath = `${CHECKOUT}/static-app/src/pages.ts`;
  await run(
    "sh",
    ["-c", `sed -i 's/>Loopback dev fixture</>${FIXED_HEADING}</' ${JSON.stringify(pagesPath)}`],
    { timeout: 30_000 },
  );
  const changed = await git("status", "--porcelain");
  if (changed.trim() === "") fail("the edit changed nothing in the checkout");
  await git("add", "-A");
  await git("commit", "--quiet", "-m", `Resolve ${REVIEW_SLUG}: name the fixed heading`);
  const fixCommit = await git("rev-parse", "HEAD");
  const fixBranch = await git("rev-parse", "--abbrev-ref", "HEAD");
  if (fixCommit === capturedCommit) fail("the commit did not move HEAD");

  // The change has to reach the running application, or the after screenshot is
  // a picture of the defect at a new commit. The fixture's pages are module
  // constants, so the development server is restarted exactly as a developer
  // would restart theirs.
  const stopped = await stopDevelopmentServer();
  spawn("node", [`${CHECKOUT}/static-app/src/main.ts`], {
    // Its own session, so it outlives this process and the `docker compose
    // exec` that started it. `detached` is Node's own `setsid(2)`; spawning the
    // `setsid` binary would be a second thing this image has to carry for an
    // effect Node already provides.
    detached: true,
    stdio: "ignore",
    env: { ...process.env, HOST: "127.0.0.1", PORT: "4321" },
  }).unref();

  // The bounded wait, and what it proves.
  //
  // Not that *something* answers on 4321. The process this replaced answered
  // there too, so `/healthz` returning 200 is satisfied by a restart that never
  // happened — which is exactly what happened while the stop above was a
  // `pkill` this image has no `procps` to provide, swallowed by `|| true`. The
  // condition here is the new heading in the response body, so it proves both
  // halves of what step 11 needs: something is listening on the port the route
  // names, and it is serving the build the agent just committed.
  const restartDeadline = Date.now() + 60_000;
  let servingFix = false;
  while (Date.now() < restartDeadline) {
    try {
      const response = await fetch("http://127.0.0.1:4321/");
      if (response.ok && (await response.text()).includes(FIXED_HEADING)) {
        servingFix = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  if (!servingFix) {
    fail(
      `the development application did not serve ${JSON.stringify(FIXED_HEADING)} on ` +
        "127.0.0.1:4321 within 60s of the agent's edit; if nothing was stopped above, the " +
        "process holding the port is still serving the build the finding was raised against",
    );
  }
  step("fixture.changed", {
    branch: fixBranch,
    previous_commit: capturedCommit,
    commit: fixCommit,
    heading: FIXED_HEADING,
    stopped_pids: stopped,
  });

  // ---------------------------------------------------------------------
  // Step 11. The agent captures the after screenshot.
  // ---------------------------------------------------------------------
  if (MCP_URL === "" || BROWSER_TOKEN === "") {
    fail("no §3.2 endpoint or browser credential was supplied; step 11 cannot run");
  }
  const browserUrl = new URL(MCP_URL);
  if (PROJECT_HINT !== "") browserUrl.searchParams.set("project_hint", PROJECT_HINT);
  browserUrl.searchParams.set("workspace_hint", CHECKOUT);
  const browser = new McpClient(new HttpTransport(browserUrl.toString(), BROWSER_TOKEN));
  await browser.initialise("rvp95-agent-fixture-browser");

  const started = await browser.expect("browser_session_start", {
    allocate: false,
    viewport: VIEWPORTS[0],
    idempotency_key: key("browser-start"),
  });
  // `browser_session_id`, not `id`: `browser_session_detail` names the session
  // the way every browser tool's *input* names it, so an agent can pass the
  // member straight back (`packages/protocol/schemas/mcp/v1.schema.json`).
  const browserSessionId = started.session?.browser_session_id;
  if (browserSessionId === undefined) fail("browser_session_start named no session");

  // The agent publishes its own route: the tool takes no connector, no project
  // and no browser session, and the control plane resolves all three and
  // authorises the sessions this agent session holds (`docs/MCP_SPEC.md` §7.2,
  // RVP-90). A route bound to the human's session would not admit this one.
  const published = await browser.expect("development_service_publish", {
    workspace_id: WORKSPACE_ID,
    local_host: "127.0.0.1",
    local_port: 4321,
    protocol: "http",
    ttl_seconds: 1800,
    idempotency_key: key("publish"),
  });
  const service = published.service;
  if (service.status !== "ready") {
    fail(`the agent's own route is ${String(service.status)}, not ready`);
  }

  const allocated = await browser.expect("browser_session_allocate", {
    browser_session_id: browserSessionId,
    published_service_id: service.id,
    idempotency_key: key("browser-allocate"),
  });
  const allocatedSession = allocated.session;
  const epoch = allocatedSession.control_epoch ?? 1;
  if (allocatedSession.status !== "READY") {
    fail(`the agent's browser session is ${String(allocatedSession.status)}, not READY`);
  }
  step("browser.allocated", {
    browser_session_id: browserSessionId,
    published_service_id: service.id,
    internal_origin: service.internal_origin,
    control_epoch: epoch,
  });

  await browser.expect("browser_navigate", {
    browser_session_id: browserSessionId,
    control_epoch: epoch,
    url: "/",
    wait_until: "load",
    timeout_ms: 30_000,
  });
  // The reproduction check: the fixed heading is on the page central Chromium
  // rendered through the route. Every artefact below is captured after this,
  // so a screenshot cannot be of a page that never changed.
  await waitForText(browser, browserSessionId, epoch, FIXED_HEADING, 30_000);

  // The timeout case of `docs/TESTING.md` §11, in the place it actually
  // matters: a bounded `browser_wait` for something that is not there expires
  // and reports it, rather than hanging or reporting success.
  const timedOut = await browser.call("browser_wait", {
    browser_session_id: browserSessionId,
    control_epoch: epoch,
    condition: "text_visible",
    text: "this text is never rendered by the fixture",
    timeout_ms: 3000,
  });
  if (timedOut.ok === true) fail("a browser_wait for text the fixture never renders reported success");
  step("browser.wait_timeout", {
    envelope_ok: timedOut.ok,
    code: timedOut.error?.code ?? null,
    retryable: timedOut.error?.retryable ?? null,
  });

  const artefacts = [];
  for (const viewport of VIEWPORTS) {
    await browser.expect("browser_resize", {
      browser_session_id: browserSessionId,
      control_epoch: epoch,
      viewport,
      timeout_ms: 15_000,
    });
    const shot = await browser.expect("browser_take_screenshot", {
      browser_session_id: browserSessionId,
      control_epoch: epoch,
      full_page: false,
      purpose: "verification",
      idempotency_key: key(`after-${String(viewport.width)}`),
    });
    const link = shot.artefact;
    artefacts.push({
      artefact_id: link.artefact_id,
      viewport,
      sha256: link.sha256 ?? null,
      size_bytes: link.size_bytes ?? null,
      // From the envelope. `browser_take_screenshot_result` carries no trust
      // member, so reading `shot.trust` recorded `null` on every artefact and
      // called it a trust label.
      trust: browser.lastTrust,
      instruction_policy: link.instruction_policy ?? null,
    });
  }
  step("after.captured", { artefacts });

  // ---------------------------------------------------------------------
  // Step 12. The agent submits verification and hands over.
  // ---------------------------------------------------------------------
  const verification = await bridge.expect("finding_submit_verification", {
    finding_id: finding.id,
    summary:
      `Renamed the homepage heading to "${FIXED_HEADING}" in static-app/src/pages.ts and restarted ` +
      "the development server. Reproduced the original heading before the change and confirmed the new " +
      "one through the route at both viewports.",
    branch: fixBranch,
    commit: fixCommit,
    tested_viewports: VIEWPORTS,
    checks: {
      reproduced_before: true,
      console_errors_reviewed: true,
      network_failures_reviewed: true,
    },
    artefact_ids: artefacts.map((artefact) => artefact.artefact_id),
    idempotency_key: key("verify"),
  });
  // `verification_id`, not `id`. `verification_view` names it that way and the
  // HTTP view of the same record names it `id`; the identifier is the same
  // value, and step 13 compares the two.
  const submitted = verification.verification;
  step("verification.submitted", {
    verification_id: submitted.verification_id,
    status: submitted.status,
    finding_status: verification.finding?.status ?? null,
    missing: verification.missing ?? [],
  });

  // Partial failure: the same request under the same idempotency key is one
  // record, not two (`docs/TESTING.md` §11, "Duplicate verification request").
  // The key is reused deliberately — that is the whole assertion.
  const duplicateKey = `rvp95-verify-duplicate`;
  const first = await bridge.call("finding_submit_verification", {
    finding_id: finding.id,
    summary: "A duplicate submission under one idempotency key.",
    branch: fixBranch,
    commit: fixCommit,
    tested_viewports: VIEWPORTS,
    checks: {
      reproduced_before: true,
      console_errors_reviewed: true,
      network_failures_reviewed: true,
    },
    artefact_ids: artefacts.map((artefact) => artefact.artefact_id),
    idempotency_key: duplicateKey,
  });
  const second = await bridge.call("finding_submit_verification", {
    finding_id: finding.id,
    summary: "A duplicate submission under one idempotency key.",
    branch: fixBranch,
    commit: fixCommit,
    tested_viewports: VIEWPORTS,
    checks: {
      reproduced_before: true,
      console_errors_reviewed: true,
      network_failures_reviewed: true,
    },
    artefact_ids: artefacts.map((artefact) => artefact.artefact_id),
    idempotency_key: duplicateKey,
  });
  step("verification.duplicate", {
    first_ok: first.ok,
    second_ok: second.ok,
    first_id: first.data?.verification?.verification_id ?? null,
    second_id: second.data?.verification?.verification_id ?? null,
  });
  const currentVerificationId =
    second.ok === true
      ? second.data.verification.verification_id
      : (first.ok === true ? first.data.verification.verification_id : submitted.verification_id);

  // Re-read the finding: the submission moved it and the version it now holds
  // is what the hand-over must carry.
  const afterSubmission = await bridge.expect("finding_get", { finding_id: finding.id });
  const currentFinding = afterSubmission.finding;
  const handedOver = await bridge.expect("finding_update_status", {
    finding_id: finding.id,
    expected_version: currentFinding.version,
    status: "AWAITING_HUMAN_REVIEW",
    idempotency_key: key("hand-over"),
  });
  step("handed_over", {
    status: handedOver.finding.status,
    verification_id: currentVerificationId,
  });

  // The review follows its finding to the human. `ASSIGNED` does not reach
  // `AWAITING_HUMAN_REVIEW` directly (`docs/MCP_SPEC.md` §7.6), so the current
  // status is read rather than assumed and the agent walks the edges it is
  // permitted. `ACCEPTED` is not one of them and is attempted below.
  const reviewStates = [];
  for (const wanted of ["IN_PROGRESS", "AWAITING_HUMAN_REVIEW"]) {
    const current = await bridge.expect("review_get", { review: reviewView.id });
    const view = current.review;
    if (view.status === wanted) {
      reviewStates.push({ requested: wanted, status: view.status, moved: false });
      continue;
    }
    const moved = await bridge.expect("review_update_status", {
      review_id: view.id,
      expected_version: view.version,
      status: wanted,
      idempotency_key: key(`review-${wanted}`),
    });
    reviewStates.push({
      requested: wanted,
      status: moved.review.status,
      moved: true,
    });
  }
  step("review.handed_over", { states: reviewStates });

  // ---------------------------------------------------------------------
  // The denial the product exists to make. An agent may not reach a final
  // disposition, and the attempt must be refused *and audited*.
  // ---------------------------------------------------------------------
  const denials = [];
  for (const status of ["RESOLVED", "WONT_FIX", "DUPLICATE", "ACCEPTED"]) {
    const attempt = await bridge.call("finding_update_status", {
      finding_id: finding.id,
      expected_version: handedOver.finding.version,
      status,
      idempotency_key: key(`deny-${status}`),
    });
    denials.push({
      requested: status,
      ok: attempt.ok ?? null,
      code: attempt.error?.code ?? null,
    });
  }
  // The version is re-read rather than remembered, and that is the assertion
  // rather than tidiness. `updateReview` checks the expected version *before* it
  // arms the refusal it would audit (`apps/server/src/modules/reviews/
  // service.ts`), so a stale version turns the one denial this scenario exists
  // to record into a version conflict that records nothing — and the harness's
  // "every refused disposition is audited" check would then be failing for a
  // reason that has nothing to do with authority. The version this review is
  // actually at is three moves past `reviewView`: the claim and the two status
  // moves above.
  const beforeDenial = await bridge.expect("review_get", { review: reviewView.id });
  const reviewDenial = await bridge.call("review_update_status", {
    review_id: reviewView.id,
    expected_version: beforeDenial.review.version,
    status: "ACCEPTED",
    idempotency_key: key("deny-review-accept"),
  });
  denials.push({
    requested: "review:ACCEPTED",
    ok: reviewDenial.ok ?? null,
    code: reviewDenial.error?.code ?? null,
  });
  step("denials", { attempts: denials, browser_take_screenshot_on_bridge: bridgeCannotDriveBrowser });

  // `browser_session_control_input` requires an idempotency key like every
  // other state-changing tool; ending a session is a state change.
  await browser.expect("browser_session_end", {
    browser_session_id: browserSessionId,
    control_epoch: epoch,
    idempotency_key: key("browser-end"),
  });
  bridge.close();
  browser.close();

  report.agent_session_id = agentSessionId;
  report.review_id = reviewView.id;
  report.finding_id = finding.id;
  report.finding_screenshot_artefact_id = finding.screenshot_artefact_id;
  report.verification_id = currentVerificationId;
  report.after_artefacts = artefacts;
  report.fix_branch = fixBranch;
  report.fix_commit = fixCommit;
  report.captured_commit = capturedCommit;
  report.denials = denials;
  report.advertised_tools = advertised;
  report.ok = true;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().then(
  () => process.exit(0),
  (error) => {
    report.ok = false;
    report.error = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`agent-fixture failed: ${report.error}\n`);
    process.exit(1);
  },
);

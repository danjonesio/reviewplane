# Testing Strategy

## 1. Quality objective

Tests must prove the primary workflow, distributed protocol behaviour, security boundaries and recovery characteristics. Compilation and isolated unit tests are insufficient for this product.

## 2. Test layers

### Unit

- Domain transition rules
- Policy evaluation
- Annotation coordinate conversion
- Staleness calculation
- Redaction functions
- Protocol validation
- Control epoch logic

### Component

- API handlers with real database
- MCP tools with authorisation
- Connector route handling
- Browser worker commands
- Artefact upload and integrity
- Job processing

"With real database" makes the disposable database part of the suite's trusted computing base, so it carries requirements of its own (`apps/server/test/support/postgres.ts`, tested by `apps/server/test/test-database.test.ts`).

Readiness MUST be established over the transport the tests use. The official PostgreSQL image runs a temporary server on the container's Unix socket, with no TCP listener, while it applies the environment and the init scripts; a probe run with `docker exec` is answered by that server and says ready while the real one does not exist yet. The caller then connects over TCP and is cut off mid-migration when the entrypoint swaps the servers. This is RVP-62, and the general rule it is an instance of: a readiness check that asks a different question from the caller is not a readiness check.

Every wait in a fixture MUST be bounded in a way that can actually be reached. A deadline read only between attempts is not a bound when an attempt can block for ever, which is what an unbounded subprocess call in a poll loop produces: the run stalls instead of failing, and a stalled gate reports nothing at all. Subprocess invocations in fixtures MUST therefore carry their own timeout, and the bound SHOULD be tested rather than assumed.

A fixture reset MUST NOT be able to deadlock against the code under test. A component's `stop()` returning is not the same instant as its last statement committing, so a reset that truncates while a straggler is writing will sooner or later meet the opposite lock order. Taking the locks with `NOWAIT` removes the possibility rather than the likelihood — a session that never waits for a lock cannot be in a deadlock cycle — and a bounded backoff handles contention. A reset that fails intermittently blames the test that was about to run rather than the one that caused it, which is the hardest failure in a suite to read.

### Contract

- TypeScript and Go schema compatibility
- MCP tool schema snapshots
- Connector message compatibility
- Event payload compatibility
- API envelope, error-code and pagination-cursor compatibility

Contract tests for a protocol run one committed fixture corpus in every language that speaks it. For the connector protocol that corpus is `packages/protocol/fixtures/connector/v1/`: its manifest lists the frames that must be accepted, with their canonical encodings, and the frames that must be refused, with the reason each must report. `pnpm protocol:check` runs the corpus in both languages and additionally fails when either language's generated models differ from the schema source, which is the snapshot test for an unreviewed schema change.

The platform corpus (`packages/protocol/fixtures/platform/v1/`) does the same for the event envelope of `docs/EVENTS.md` §2, the project event-stream control messages of `docs/API.md` §18.1 and the refusal body of §5. Beside it, `cursors.json` is the golden pagination-cursor corpus: each set of claims records the exact text both languages must produce, and each malformed cursor records the stable refusal it must report.

The API's compatibility surface is therefore held by that corpus rather than by an OpenAPI document. The corpus is the stronger of the two here: it asserts the exact bytes both languages produce and the exact refusal each malformed message must report, which an OpenAPI snapshot does not. An OpenAPI document becomes worth generating when the route inventory is complete enough for one to describe the whole API rather than the part that happens to be built.

### Integration

- API, PostgreSQL and both artefact-store drivers
- Browser worker and tunnel gateway
- Connector and loopback dev server
- MCP client and review retrieval
- WebSocket live frames and control

Running today: `apps/server/test/connector-integration.test.ts` (enrolment, channel, revocation, and the `ss -ltnp` evidence that the connector opens no listening socket) and `apps/server/test/route-publication.test.ts` (route publication end to end through the real connector binary and a real loopback service, including `PORT_NOT_LISTENING` after the bounded grace, `DESTINATION_NOT_ALLOWED`, `PROJECT_NOT_AUTHORISED`, `CONNECTOR_OFFLINE` and `ROUTE_EXPIRED`). Both build `services/connector` from source, so neither can drift from the binary an operator runs.

The live-frame integration runs against a real listening server and a real
WebSocket client (`apps/server/test/live.test.ts`), because the properties
under test are properties of the handshake and of message ordering: a refusal
before the upgrade, a text metadata message immediately followed by the binary
message it describes, and a worker stream that closes when the last viewer
leaves. The measured-rate half of section 12 is settled in the browser suite,
where a real Chromium is producing the frames.

### End to end

Complete user workflows in deployed Compose environment.

### Security

Negative authorisation, isolation, redaction and hostile-input tests.

### Fault injection

Disconnects, crashes, latency, partial uploads and restarts.

## 3. Primary end-to-end scenario

Automated scenario:

1. Start Compose stack.
2. Enrol connector fixture.
3. Start fixture web application on connector loopback.
4. Publish service.
5. Start browser session through MCP.
6. Navigate and capture live frame.
7. Human test client creates annotated finding.
8. Create `bugs-on-homepage` review.
9. Agent fixture retrieves and claims it.
10. Agent changes fixture state or branch simulation.
11. Capture after screenshot.
12. Submit verification.
13. Human accepts.
14. Export review.
15. Verify event sequence and artefact hashes.

Steps 1 to 6 run automatically as `pnpm test:e2e` (`deploy/compose/e2e/run.sh`). It starts the Compose stack, enrols the connector fixture, starts the fixture applications on connector loopback, publishes them, reserves and allocates browser sessions against the routes, and navigates central Chromium to the internal origins. Every step asserts its own outcome and a step that cannot be verified aborts the run; evidence lands in `deploy/compose/e2e/evidence/`.

The same script then proves the tunnel capabilities `ARCHITECTURE.md` §7.4 makes mandatory, which those six steps do not reach: a WebSocket echo, server-sent events asserted on arrival timing, and Vite hot module replacement applying a source edit made on the development machine without a full page reload. It ends by recording the §12 baseline. These are numbered separately in the script because they are not steps of the scenario above; they are the capabilities the route has to have for that scenario to mean anything.

Steps 7 to 15 need reviews, findings, verification and export, and arrive with the issues that introduce them.

This scenario is release-blocking.

### 3.1 What runs automatically today

| Steps | Harness | Command |
|---|---|---|
| 5 to 7, browser side | `apps/browser-worker/test/browser/` | `pnpm test:browser` |
| 7, annotation UI | `apps/web/test/ui/` | `pnpm test:ui` |
| 8 to 12 | `apps/mcp-server/test/integration/` | `pnpm --filter @reviewplane/mcp-server run test:integration` |

Steps 9 to 12 — agent retrieves and claims `bugs-on-homepage`, changes the
fixture application, captures the after screenshot and submits verification —
run against real components: a real PostgreSQL, the real control-plane process,
the real MCP server, a real Chromium browser worker in its own process, and the
official MCP TypeScript SDK as the client. The suite runs in the browser
worker's own image under the container controls of
`deploy/compose/compose.yaml`, on an internal Docker network whose only
reachable peer is its database, with a unique name per run.

Steps 1 to 4 need the connector, and steps 13 to 15 need human acceptance and
review export; both arrive in Stage 1.

These three harnesses build images and run Chromium, so they run in
`.github/workflows/container-harnesses.yml` rather than in the root gate
workflow. That workflow runs nightly, on demand, and on every pull request whose
change is not documentation-only; the `ci:harnesses` label forces it to run on a
pull request the filter exempted. Section 16 records the trigger rules and why
they are shaped this way. The root gates of `docs/DEVELOPMENT.md` section 5 run
on every pull request in `.github/workflows/ci.yml`. Neither workflow gates a
release yet: see section 16.

## 4. Domain tests

Required transition tests:

- Agent cannot accept human finding
- Human can reopen resolved finding
- Accepted review cannot mutate silently
- Finding claim uses optimistic version
- Review slug uniqueness is project scoped
- Staleness warning does not auto-close finding
- Verification requires evidence under policy

They are exercised where the rule lives. Six run without a database or an HTTP
server, in `apps/server/test/review-domain.test.ts`, because the rules are pure
functions over a status, an actor type and a source: a rule that can only be
reached through a handler and a transaction is a rule nobody will exercise. The
two with a genuinely stateful half — "review slug uniqueness is project scoped",
which is a partial unique index, and the concurrent half of "finding claim uses
optimistic version" — run against a real database in
`apps/server/test/review-lifecycle.test.ts`, where two callers race one row lock
and exactly one wins.

"Staleness warning does not auto-close finding" is asserted structurally rather
than by simulating a warning: no non-human actor may request any final
disposition, so nothing a staleness calculation could return would close a
finding (`docs/DOMAIN_MODEL.md` section 24).

The transition tables and their authority column are **data** in
`packages/protocol/schemas/review/v1.schema.json` (ADR-0024), so the domain
tests assert against the table the server reads rather than against a second copy
of the rule. A contract test holds the agent-permitted set to the six transitions
of `docs/MCP_SPEC.md` section 7.7 and the agent-reachable review statuses to the
three of `docs/DOMAIN_MODEL.md` section 14.

Required authority and audit tests:

- An agent credential is refused on every finding-disposition route, and nothing
  moves
- An `agent_session` actor reaching the domain layer directly — the path the MCP
  server takes — is refused for `RESOLVED`, `WONT_FIX` and `DUPLICATE`, and each
  attempt records `finding.status_change_denied`
- A client-supplied `source` is refused rather than honoured, and a finding's
  source follows the actor that created it
- Comment attribution cannot be spoofed, and an edit by another actor is refused
- A foreign review and a foreign finding are answered exactly as unknown ones
  are, on every route added with the lifecycle work

## 5. Control-lease tests

- Agent owns initial epoch
- Human takeover increments epoch
- Agent command with prior epoch is rejected
- Human disconnect expires lease safely
- Hand-back captures fresh state
- Duplicate control commands are idempotent
- Two users cannot both obtain lease
- System screenshot does not steal interactive lease

## 6. Connector and tunnel tests

- Loopback HTTP route
- WebSocket hot reload route
- Server-sent events
- Chunked and otherwise streamed responses
- Upgrade denied without a capability, with another project's capability, or on header-based route confusion
- Upgrade to a protocol other than `websocket` refused
- Closure propagated in both directions, browser-initiated and service-initiated
- Long editing pause: an idle upgraded connection survives its configured window
- Connector reconnect
- Route expiry
- Revocation during active stream, including an already-upgraded connection
- Destination host substitution rejected
- Cross-project capability rejected
- Link-local and metadata destination rejected
- Stream and memory limits
- Malformed frames, in the data channel and on an upgraded connection
- Slow consumer and backpressure
- Heartbeat flood dropped, and a channel ended when the flood persists
- Workspace observation refused for a project the identity is not enrolled for
- Workspace identifier already held in another project refused
- No workspace observation for an unchanged repeat
- Connector reports nothing about paths it was not configured with

Connector reconnect is the Stage 0 exit criterion "Protocol round trip survives connector reconnect", and it is a three-part assertion rather than a single one: a request issued before the interruption succeeds, a request issued during it fails with `CONNECTOR_OFFLINE` or `PUBLISHED_SERVICE_UNAVAILABLE` and does not hang, and an equivalent request issued afterwards succeeds over the same `route_id` against the same destination with no operator action. A test making it MUST also show that no request was served by a different environment, which needs a second environment to be wrong about.

Running today: `services/connector/internal/protocolsim` (the Protocol simulation mode of `DEVELOPMENT.md` §4 — the three-part round trip, the six-field reconnect payload, routes closed on reconciliation, the desired-state timeout, flapping reconnects, the terminal upgrade classification, and the measured reconnect-time distribution over ten forced disconnects), `apps/server/test/connector-reconnect.test.ts` (a real connector process killed and restarted, a control-plane restart, claims on another connector's route, an expired route, a revoked identity, and browser sessions degraded and resumed) and `apps/server/test/reconciliation.test.ts` (the decision table).

### Connector lifecycle and workspace observation

Running today: `apps/server/test/connector-lifecycle.test.ts`, against a real
database, covering enrolment-token issuance from a human session (a cookie
session with its CSRF header succeeds; the cookie alone, a wrong token and an
absent token are each refused; a project the caller cannot reach is absent
rather than forbidden; a machine credential mints nothing; the bootstrap
operator token still works and needs no CSRF header), the environment and
connector views (an enrolled connector appears with its environment and health;
a foreign connector identifier answers exactly as an unknown one), revocation
(the channel closes, the credential is refused afterwards, and the response
reports what the revocation reached; a forged revocation is refused; a connector
in another organisation is reported absent) and workspace observations (a first
observation creates the record and a change records both sides; a connector
enrolled for one project cannot report for another; an identifier held in
another project cannot be claimed; the observed workspace reaches the project's
environment view). Its derivation tests pin the path hash's shape and
stability, that a display label is a directory name and never a path, that the
enrolment command names the control plane over `https` and reads the token from
a file, and that the heartbeat floor drops a flood and ends a channel that keeps
it up.

On the connector side: `services/connector/internal/gitcontext` (every field of
a clean checkout, every spelling of a remote normalising to one identity, a
credential in a remote being dropped, a dirty tree, a detached HEAD reported as
`HEAD`, an absent or unnormalisable remote reported as absent, a slashed branch
name, a directory that is not a checkout, a missing directory, a repository with
no commit, a missing `git` executable, a `git` that never returns being bounded
by its deadline, and allocation bounded against a flood of output) and
`services/connector/internal/workspaces` (only what moved is reported, a lost
channel makes the next report a full one, a workspace that disappears is not
reported stale, entries without an identifier or a project are skipped, and the
reconnect claim is bounded and stable across attempts).

Two of those tests assert an **absence** mechanically rather than by reading the
code: `TestPackageReadsNoFileContentsAndWalksNoDirectory` and
`TestPackageWalksNoDirectory` fail if a directory walk or a file read appears
anywhere in either package. "Broad filesystem scanning is disabled"
(`CONNECTOR_PROTOCOL.md` §9) is a privacy boundary rather than a preference, and
a boundary nothing checks is a comment.

The protocol corpus carries the same rules as refusals a decoder must produce in
both languages: `workspace-observed-with-changed-paths`,
`workspace-observed-display-label-is-a-path` and
`workspace-observed-without-connector-id` are refused, and
`workspace-observed` and `workspace-observed-no-remote` are accepted. A payload
that could carry a changed-path list would fail the corpus before it failed a
review.

A streaming test MUST assert on **arrival timing**, not only on the final body. Server-sent events fail in a specific and recognisable way when any hop buffers — every event arrives at once at stream close — and a test that compared only the assembled result would pass against exactly the implementation the capability exists to exclude.

Both ends of the data channel MUST be given the same session configuration in a test harness. The initial flow-control window is a constant of the protocol rather than of a deployment (`CONNECTOR_PROTOCOL.md` §12.2), so a harness that gave the two ends different windows would produce a protocol violation instead of the backpressure the test was asking about.

A stream deadline and a socket deadline are two clocks and MUST NOT be confused. A stream's deadline is policy — the route's expiry, read against the clock the gateway and the connector have injected, so that a test can move an expiry without sleeping for hours. A socket deadline is an absolute instant the kernel compares against the real clock, and the kernel has no other. An instant that crosses from the first to the second MUST be translated into the lifetime still remaining (`datachannel.SocketDeadline`); handing the policy instant straight to `net.Conn.SetDeadline` works only while the two clocks agree, which is the one condition an injected clock removes. RVP-61 is what that costs: a harness clock fixed at a date, seven upgrade tests passing until the wall clock passed it, and then failing on every run afterwards for a reason that looks like a network fault. A harness clock therefore SHOULD be fixed rather than seeded from `time.Now`, because a fixed origin makes the mistake fail immediately instead of intermittently, and `services/tunnel-gateway` carries a test that fails when any deadline in the module is set from an instant that does not name the real clock.

## 7. Browser tests

- Launch and termination
- Context isolation between projects
- Cookie isolation
- Viewport and device-scale handling
- Screenshot correctness
- Annotation alignment after resize and scroll
- Console capture and redaction
- Network metadata capture
- Trace finalisation
- Worker crash and orphan cleanup
- Browser sandbox configuration check

These live in `apps/browser-worker/test/browser/` and run with `pnpm test:browser`, which builds the worker image and runs the suite inside it under the same container controls `deploy/compose/compose.yaml` applies. Running them anywhere laxer would not answer the question the sandbox check asks. They are excluded from `pnpm test` because they need a Chromium and its system libraries.

The suite drives the worker against the fixture applications in `test/browser/fixture-app.ts`, including a page whose visible content instructs the agent to change policy and exfiltrate source. Element-reference tests assert that a stale reference fails rather than targeting whatever now occupies its position, which is the failure mode a passing "it clicked something" test would hide.

Live capture is exercised in the same suite. It needs a page that repaints,
because a CDP screencast emits on paint and a static page produces one frame
and then silence; `fixture-app.ts` therefore serves an animated page whose only
purpose is to give the compositor work. The measured rate for each mode is
printed by the run, so the figures `docs/TESTING.md` section 12 asks to be
published come from the suite rather than from a separate benchmark.

## 8. MCP tests

- Project resolution
- Ambiguous project failure
- Named review lookup
- Resource authorisation
- Bounded snapshots
- Trust labels on page content
- Agent forbidden transitions
- Idempotency conflict
- Capability degradation for clients without image support
- Inbox acknowledgement semantics
- Completion-gate missing evidence response

Every item on this list except the last two is covered by
`apps/mcp-server/test/mcp.test.ts`, which drives the endpoint with the official
MCP TypeScript SDK client against a real database. Inbox semantics and
completion gates arrive with the tools they test, in Stage 1.

The suite also holds the properties that are specific to the Stage 0 agent
surface: the advertised tool set equals the schema's availability set; no
advertised status enumeration can express a final disposition; a slug from
another project resolves as not found; an agent credential is refused by the
administrative API; a human session cookie is refused as agent authentication; a
credential that expires mid-session refuses the next call rather than executing
part of it; a transport session identifier is not a credential; and no tool
response carries a credential.

`apps/mcp-server/test/unit.test.ts` holds the contract snapshot of the
advertised tool schemas, so a breaking tool change cannot land silently
(section 2 "Contract").

## 9. API tests

- CSRF protection
- Session rotation
- Cursor pagination
- Optimistic concurrency
- WebSocket authentication
- Event resume from sequence
- Artefact upload intent and completion
- Short-lived content access
- Rate limits
- Stable error codes

## 10. Security tests

### Isolation

- Organisation A cannot enumerate organisation B IDs
- Project A agent cannot access project B review
- Worker session credentials cannot call admin API
- Connector token cannot become human session
- A connector cannot report a workspace into a project it was not enrolled for
- A connector cannot claim a workspace identifier another project holds

`apps/server/test/connector-lifecycle.test.ts` covers the connector surface's
share of this: a foreign connector identifier and an unknown one produce
**byte-identical** response bodies, asserted as equality of the bodies rather
than of their status codes, because a difference in wording is as much an
existence oracle as a difference in status. The two workspace refusals above are
one outcome in the implementation for the same reason.

### Human authentication

`apps/server/test/identity.test.ts` and `apps/server/test/projects.test.ts`
cover these against a real database:

- The install token creates exactly one administrator and is refused on reuse,
  after expiry, and when it was never issued
- A state-changing request with a missing, wrong or borrowed CSRF token is
  refused; the ADR-0016 viewer session, which carries none, cannot reach one
- The login rate limit engages, carries a retry hint, and refuses the correct
  password while it holds
- A connector enrolment token cannot become a human session as a bearer
  credential, as a password, or as an install token
- An agent credential and a worker credential can call neither a human session
  route nor project administration
- A session scoped to project A cannot read project B, cannot enumerate it, and
  is answered byte for byte as it is for an identifier that does not exist
- No credential material reaches a log line or an event payload
- A revoked or rotated session cookie is refused when it is replayed
- With the database unavailable, a sign-in fails clearly and issues no session
- Two concurrent creations of one project slug produce one project and one
  stable refusal

### Prompt injection

Fixture pages include malicious instructions. Tests verify:

- Responses are labelled untrusted
- Page text cannot change project policy
- Sensitive action still requires approval

### Redaction

Fixtures include:

- Password inputs
- API keys in headers
- Tokens in console output
- Sensitive selectors

Verify persisted artefacts and logs are redacted according to policy.

### Artefacts

- Malicious SVG and HTML
- MIME mismatch
- Oversized upload
- Hash mismatch
- Path traversal in filename metadata
- Active content served from isolated origin or attachment
- Cross-project artefact access returns not-found
- Expired access token refused
- Agent without image-resource capability receives a degraded response

`apps/server/test/artefact-security.test.ts` and
`apps/server/test/artefact-store-stage-1.test.ts` cover these against a real
database. Two of them are worth stating precisely, because a weaker assertion
would pass while the property was broken.

**Cross-project access is compared byte for byte** against the refusal an
identifier that never existed produces. `RESOURCE_NOT_FOUND` for both is not
enough on its own: a different message, or a different `details` object, is
still an oracle telling a caller that the identifier exists. The same comparison
is applied to `GET /api/v1/artefact-content/:grantId`, where an unknown grant,
an expired one, an unauthenticated caller and a live grant presented by the
wrong subject must all produce one status and one body.

**A refusal must carry no deployment data.** The store-unavailable cases assert
that the response contains neither the server's artefact root nor the raw driver
error, because `docs/SECURITY.md` §18 keeps both in the log rather than in a
body an agent session or a browser worker can read.

**Active content is asserted at both ends.** The server's response must carry
`Content-Disposition: attachment` with `nosniff`, a sandboxing policy and
`X-Frame-Options: DENY`; the browser suite asserts over the rendered DOM that
the viewer's panel for such an artefact contains no `img`, `iframe`, `object`
or `embed`, so a later change that reintroduces one fails.

### Artefact storage drivers

ADR-0012 requires the driver interface to be conformance-tested against both
drivers, and `apps/server/test/artefact-driver-conformance.test.ts` runs one
list of cases against `filesystem` and against `s3`: content addressing,
idempotent rewrite, traversal refusal, verification, deletion, the availability
probe and usage.

The `s3` run signs against an in-process S3-compatible endpoint that recomputes
the AWS Signature Version 4 over every request and refuses one that does not
match, so it exercises the driver's own canonicalisation, percent-encoding,
signed-header list and payload digest rather than agreeing with whatever it is
sent. It is **not** a claim that the driver works against any particular vendor:
multipart upload, versioning and lifecycle rules are not implemented, and
testing against an external service is a later stage (`docs/DEPLOYMENT.md` §12).
Setting `REVIEWPLANE_TEST_S3_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY` and
`_SECRET_KEY` points the same suite at a real endpoint unchanged.

## 11. Fault-injection matrix

| Failure | Expected behaviour |
|---|---|
| Connector disconnect during navigation | Action fails clearly, route unavailable, session remains diagnosable |
| Connector process killed and restarted | Route resumes under the same `route_id` and destination, no operator action |
| Network partition with the connector process alive | Bounded jittered reconnect; requests fail with a stable code meanwhile |
| Control-plane restart while a connector is connected | Connector reconnects and reconciles; unexpired authorised routes continue |
| Connector disconnect during an open data stream | Stream fails with `CONNECTOR_OFFLINE`, never a generic error and never a hang |
| Repeated flapping reconnects | No duplicate routes, no leaked streams |
| Timeout awaiting the reconnect desired state | Connector serves no route rather than serving an unreconciled one |
| Worker crash after screenshot upload | Uploaded evidence remains, session marked failed |
| Worker crash after upload, before completion | Artefact stays `uploaded`, no grant is minted, a replacement completes it |
| Upload intent retried with the same idempotency key | One artefact; a different body is `IDEMPOTENCY_CONFLICT` |
| API restart during live view | Client reconnects and refreshes state |
| Database unavailable | State changes denied; no unaudited continuation |
| Artefact store unavailable | Verification remains incomplete; refusal names the store; state unchanged and retryable |
| Filesystem artefact volume full or read-only | Driver reports it; nothing recorded available; upload retryable |
| Human takeover during agent click | Ordered lease transition, no concurrent input |
| Duplicate verification request | One verification record through idempotency |
| Retention deletion partial failure | Retry, metadata not falsely tombstoned |
| Development service closes a WebSocket | Closure reaches the browser with the service's close code and reason |
| Connector disconnect during an open WebSocket | Connection closed, route answers `CONNECTOR_OFFLINE` |
| Route revoked during an open WebSocket | Connection closed promptly, not at the next request |
| Exceeding the stream limit with upgraded connections | `STREAM_LIMIT_EXCEEDED` |
| Long editing pause with no traffic | Connection survives the configured idle window and closes past it |
| PostgreSQL not yet ready at start-up | The API reports itself not ready, keeps answering liveness, and does not exit into a restart loop |
| Artefact volume unwritable | `reviewplane status` reports the artefact store unavailable and exits 4 |
| Artefact write probe that never returns | The probe is bounded and reported as unavailability, rather than hanging the status command |
| Missing secret file | Compose refuses to start the service, naming the file |
| No browser worker registered | `reviewplane status` reports zero capacity as a warning, not a failure |
| Browser worker stopped after registering | Its slots stop being counted once it has been silent past the staleness threshold; `reviewplane status` reports zero capacity and names the silence rather than the absence |

## 12. Performance tests

Measure:

- Browser allocation latency
- Live frame latency and drop rate
- Tunnel throughput and hot-reload responsiveness
- Screenshot capture latency
- Review retrieval latency
- Event fan-out
- Concurrent browser capacity
- Object upload throughput

Publish tested hardware and configuration.

Tunnel throughput and hot-reload responsiveness are measured by the Compose scenario (`deploy/compose/e2e/run.sh`) and written to `evidence/performance-baseline.txt` on every run, alongside the configuration and the machine the figures came from. Hot-reload responsiveness is measured as the wall-clock time from the source edit landing on the development machine to the updated text being visible in central Chromium, which is the figure a user experiences; it therefore includes the file watcher, the bundler and the browser, not the tunnel alone. A baseline is a recorded number, not a threshold: `docs/ROADMAP.md` defers tuning, so the scenario records the figure and does not fail on it.

## 13. Upgrade tests

For each supported upgrade path:

- Restore prior-version fixture
- Start new version
- Apply migration
- Verify reviews and artefacts
- Verify connector compatibility
- Verify rollback limitations

The Stage 0 prior-version fixture is committed at `test/fixtures/stage0/`: a
PostgreSQL dump at the Stage 0 migration head, the artefact-store files its rows
reference, and a manifest carrying the product commit, the schema version, the
per-table row counts a restore must reproduce and a SHA-256 for every file. It
holds the named review `bugs-on-homepage` with two annotated human findings and
one agent-submitted verification whose after screenshot is in the store. It was
produced by running the Stage 0 product loop against real components rather than
by writing rows, and carries no key material: `connector_tls_material` is
excluded from the dump. `bash test/fixtures/stage0/verify.sh` restores it into a
disposable PostgreSQL and checks it against its manifest; the fixture's own
README states what it contains and how it was captured.

## 14. Backup and restore tests

- Full backup and restore
- Database-only plus existing external artefact storage
- Missing key failure
- Corrupt archive detection
- Restore to new hostname
- Integrity hash verification

## 15. UI and accessibility tests

- Keyboard navigation
- Focus order
- Screen-reader names
- Reduced motion
- Annotation list alternative
- Responsive layouts at 390x844 and 1440x900
- Browser live surface reconnect
- Before-and-after comparison

Annotation alignment is proved in `apps/web/test/ui/annotation.browser.test.ts`,
which owns the Stage 0 exit criterion "a screenshot annotation aligns after UI
resize". Every case measures two things and requires them to agree: where the
mark sits as a fraction of the rendered content rectangle, and what the
screenshot itself shows at that same fraction. The fixture page paints a
distinctly coloured region, the annotation claims exactly that region, and a
mark that drifts by a few per cent lands on the background instead — so the
suite cannot pass by proving only that an overlay exists somewhere. The
conditions are 390x844 and 1440x900, device pixel ratio 1 and 2, an in-page
container resize, a panel scroll and a zoom change. The contained-rectangle
arithmetic is recomputed inside the test from `getBoundingClientRect` and
`naturalWidth` rather than read from the component, so a mistake shared between
renderer and test cannot cancel itself out.

Connector enrolment is proved in `apps/web/test/ui/connector.browser.test.ts` at
both viewports: the enrolment page states the command, the expiry, the project
scope, the expected labels and the shown-once warning; connector health is
stated as text beside its badge rather than by colour alone; the empty state
names a cause and an action; completion is announced in a live region; and
revocation asks for confirmation and then reports what it did. One case covers
the command's reachability specifically — that it can be focused, selected and
copied by keyboard alone, and that a refused clipboard falls back to selecting
it and saying so — because a page whose only route out was a clipboard the
browser declined would be a page a keyboard user could not finish
(`UX_FLOWS.md` §5). Two further cases assert that a session room states the
workspace's branch, commit and dirty state, and names the absence of a workspace
rather than showing nothing.

These live in `apps/web/test/ui/` and run with `pnpm test:ui`, which builds the
bundle and drives it in a real Chromium against a stub control plane that
speaks the generated live-view protocol. They are separate from `pnpm test` for
the same reason the browser suite is: a Chromium and its system libraries are
not assumed on a developer's machine, so the suite runs inside the browser
worker's image under the same container controls.

The stub is restartable, which is what makes the API-restart case of section 11
testable end to end: the control plane is stopped mid-stream, the page is
asserted to show `Reconnecting`, the control plane is restarted on the same
port, and the page is asserted to return to `Live` with its painted-frame count
still advancing. The suite also asserts that the page issues no request to any
host but its own, which is ADR-0011's no-CDN requirement observed at run time
rather than in the bundle.

Frame-lifetime evidence is split deliberately: `apps/server/test/live.test.ts`
proves the artefact store, the database and the event payloads hold no frame
after a sustained viewing session, and
`apps/browser-worker/test/browser/live.browser.test.ts` proves the same of the
worker's own filesystem — including that the ephemeral profile directory gains
no image file and does not survive termination.

## 16. Release gates

A release cannot ship when:

- Primary end-to-end scenario fails
- Cross-project isolation tests fail
- Stale control commands are accepted
- Migration or restore test fails
- Browser worker runs with unsupported insecure defaults
- Critical dependency vulnerability lacks documented mitigation
- Protocol compatibility tests fail

No release pipeline enforces this list yet, and the list is not a description of
what gates a change. The two workflows that exist are change gates, and they run
as follows.

### 16.1 What runs on a change today

| Suites | Workflow and rolled-up check | When it runs |
|---|---|---|
| `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm protocol:check`, `pnpm test`, and `go vet ./...`, `go test ./...` and `go test -race ./...` in each Go module | `.github/workflows/ci.yml`, reported as `CI gates` | Every pull request, every push to `main`, and on demand |
| `pnpm test:browser`, `pnpm test:ui`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:edge`, `pnpm test:install` | `.github/workflows/container-harnesses.yml`, reported as `Harness gates` | Every pull request whose change is not documentation-only; nightly against `main`; on demand; and on any pull request carrying the `ci:harnesses` label |

The root gates cover the protocol compatibility condition above. The automated
parts of the primary end-to-end scenario — steps 1 to 6 as `pnpm test:e2e` and
steps 9 to 12 as `pnpm test:integration` — now run on the change that could break
them rather than reporting the next morning.

A pull request is **documentation-only** when every file it changes is a Markdown
document or lives under `docs/`. Every other change runs every harness: a schema,
an application source or test tree, a Go service, the Compose stack, a
Dockerfile, a lockfile or a workflow file. The exemption MUST stay expressed that
way round. An allowlist of code paths omits whichever directory is added after it
was written, and omitting a path means not running — which is the failure this
rule exists to prevent. RVP-73 records the instance: a request-schema change
merged without the harnesses and left `pnpm test:integration` failing on `main`
until an unrelated pull request happened to carry the label.

The filter is evaluated in a job inside the workflow, and MUST NOT be moved into
an `on.pull_request.paths` condition. A workflow that `paths` filters out does
not run, so it reports nothing, and an absent check cannot be told apart from a
check nobody added. Deciding inside the workflow means `Harness gates` reports on
every pull request: green when every harness passed, green when the change was
documentation-only — recording in the run summary which files led to that — and
red when a harness the change required did not run or did not succeed.

The `ci:harnesses` label remains a manual override. It forces the harnesses onto
a pull request the filter exempted; it is no longer how they are obtained.

`CI gates` and `Harness gates` are the two status checks to require on `main`
(AGENTS.md, "Change delivery"). The `protect main` ruleset does not list them
yet, so today they report rather than block, and a maintainer who merges past a
red one is doing so knowingly.

`pnpm test:install` owns two of the conditions above: it runs
`docs/DEPLOYMENT.md` section 8 verbatim from a clean checkout to a
rendered login page, which is the Stage 1 exit criterion "fresh installation from
release artefacts in one documented flow", and it asserts that the browser worker
is not running with unsupported insecure defaults — non-root, sandbox enabled as
the worker itself reported it at registration, no Docker socket, no database or
artefact credential, and no published debugging port. The remaining conditions
have no automated owner. RVP-57
builds the release pipeline that makes every condition above blocking, and the
list here is its specification rather than a description of what runs today.

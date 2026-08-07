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
7. Human test client creates the `bugs-on-homepage` review.
8. It creates an annotated finding in it, against the captured screenshot.
9. Agent fixture retrieves and claims it.
10. Agent changes fixture state or branch simulation.
11. Capture after screenshot.
12. Submit verification.
13. Human accepts.
14. Export review.
15. Verify event sequence and artefact hashes.

Steps 7 and 8 are written in that order because it is the only order the control plane has: a finding is created **into** a review, so the review exists first, and the web application's capture flow does exactly this — one `POST .../reviews`, then one `POST .../reviews/:id/findings` per draft (`apps/web/src/components/CaptureFinding.tsx`). An earlier revision named the finding first, which no client can do.

All fifteen steps run automatically as `pnpm test:e2e` (`deploy/compose/e2e/run.sh`), against the shipped Compose deployment. Every step asserts its own outcome and a step that cannot be verified aborts the run; evidence lands in `deploy/compose/e2e/evidence/`.

Step 3 also proves workspace observation, which is the other half of what a connector is for. The fixture's development environment holds a real Git checkout, and the scenario waits for the connector's own `workspace.observed` and asserts the recorded head commit against what `git rev-parse HEAD` answers inside that environment, the recorded path hash against the digest of the configured path, and that **no filesystem path was stored** (`DOMAIN_MODEL.md` §9). It then switches the checkout's branch and commits, and asserts `workspace.head_changed` carrying both sides of the move within a bound derived from `git_context.interval`. The workspace row MUST NOT be written by the scenario: it was, once, with a placeholder head commit and a path hash of sixty-four zeroes, which meant a release-blocking scenario asserted the shape of an observation that had never happened. Removing the connector now fails the run at that step.

The same script then proves the tunnel capabilities `ARCHITECTURE.md` §7.4 makes mandatory, which the scenario does not reach: a WebSocket echo, server-sent events asserted on arrival timing, and Vite hot module replacement applying a source edit made on the development machine without a full page reload. It ends by recording the §12 baseline. These are numbered **T1 to T3** in the script, not 7 to 9, because they are not steps of the scenario above; they are the capabilities the route has to have for that scenario to mean anything, and sharing its numbering made two different lists look like one.

### The human is a real account, not the operator token

Steps 7, 8 and 13 are driven by a client that claims the installation with the token `reviewplane install-token` mints, signs in with `POST /api/v1/auth/sessions`, and presents the session cookie with its `X-CSRF-Token` on every write. That is a requirement of this scenario and not an implementation detail. The bootstrap operator token the rest of the script uses is a principal with `organisationId: null` **and** `projectIds: null`, so every tenancy term in every scoped query goes vacuous under it: an acceptance driven by it would pass against a control plane that had no idea who was accepting, which is exactly the failure §10 describes. The run additionally asserts that a cookie write with no CSRF header is refused before the body is read, that the review record names the signed-in user as its accepting actor, and — the invariant the product exists for — that an **agent** credential presented to the same accept route is refused and moves nothing.

Two things had to be repaired before this could run at all, and both are recorded here because a scenario that worked around them silently would be claiming more than it proves.

**A fresh installation held two organisations.** Migration `0055` seeds the Stage 1 organisation and the single administrator account; the connector module separately ensured `REVIEWPLANE_ORGANISATION_ID` existed, defaulting to `org_default`. So the only human was in one organisation and every connector, project, review and event was in the other, and a signed-in administrator could reach none of the deployment's own projects — every refusal correct, and the product loop impossible to complete. The connector module now **adopts** the deployment's organisation when none is configured and creates one only when the deployment holds none. That is the half of RVP-63 this scenario is blocked by; the rest of that issue — refusing a configured identifier that disagrees with the seed, and a path for an installation that already holds both rows — is still open. The step 7 assertion that the human's organisation is the deployment's is what keeps the repair honest.

**The local MCP bridge could not reach the agent endpoint.** It derived `/mcp/v1` from the connector's own control-plane URL, which in this deployment is the mutually authenticated connector listener and serves `/connector/v1/*` only, so the bridge exchanged a valid credential and then met a 404. `control_plane.mcp_url` now names the agent endpoint (ADR-0039), and the edge gateway joins the development network because a development machine reaches a deployment at its published address.

### What steps 9 to 12 exercise, and what they do not

The agent fixture (`deploy/compose/e2e/agent-fixture.mjs`) runs **inside the development environment**, spawns `reviewplane-connector mcp` and speaks newline-delimited JSON-RPC over its stdin and stdout — the transport an MCP client's stdio transport speaks. So the ADR-0023 credential exchange over mutual TLS, and the resolution of the project from the working directory, are exercised rather than bypassed. Every review, finding, inbox and verification call goes over that session. It polls `agent_inbox_list` for the assignment rather than being told, because nothing is pushed to an agent.

Step 11 does **not** go over the bridge, and the reason is a real gap rather than a convenience. A bridge credential carries the workflow capabilities and no browser capability at all (`BRIDGE_CAPABILITIES`, `docs/SECURITY.md` §6.3), while `finding_submit_verification` requires at least one screenshot artefact — so an agent on the bridge can retrieve, claim and resolve a finding but cannot capture the evidence its own hand-over demands. The fixture therefore opens a **second** MCP session at the same `/mcp/v1` endpoint with an administrator-issued agent credential, which is the shipped way an agent obtains browser authority. Both sessions are real MCP clients and only the credential differs. The gap needs its own decision and does not have one.

Step 10 is a real change to the development machine: the agent edits the checkout the connector observes, commits it — `finding_submit_verification` refuses a commit equal to the one the finding was captured at — restarts the development server, and waits for the new text to be visible in central Chromium through the route before capturing anything. A screenshot taken before that wait would be a picture of the defect at a new commit.

### What the run asserts, and what it does not

Asserted: the ordered event subsequence `workspace.observed`, `published_service.ready`, `browser_session.ready`, `review.created`, `finding.created`, `finding.annotated`, `review.assigned`, `inbox_item.created`, `inbox_item.acknowledged`, `review.claimed`, `finding.claimed`, `finding.verification_submitted`, `finding.verification_accepted`, `finding.resolved`, `review.accepted`, with per-project monotonic `sequence` and no repeated event identifier; `connector.enrolled` separately, on the organisation's stream, because enrolment precedes any project association and the stream key is the project where one exists and the organisation otherwise. `review.created` precedes `finding.created` for the reason given above.

Also asserted: every artefact's recorded digest against the bytes read back through a subject-bound grant, for the before screenshot and both after screenshots; that the annotated original is byte-unchanged and that its annotations name one artefact and produced none, because an overlay is geometry against the original (ADR-0006); that the exported document is `metadata_only`, names the accepted review and finding, and carries a `sha256` for every artefact in its manifest.

Fault cases covered inside the run: **denial** — four final dispositions and a review acceptance requested by an agent, each refused and each audited, plus an agent credential refused on the human accept route with nothing moved; **timeout** — a bounded `browser_wait` for text the fixture never renders, which expires and reports it; **partial failure** — a duplicate `finding_submit_verification` under one idempotency key leaving exactly one `submitted` verification.

Not covered by this scenario, and named rather than implied: **connector disconnect and reconnect mid-scenario** with route reconciliation, which is proved against a real connector process in `apps/server/test/connector-reconnect.test.ts` and in `services/connector/internal/protocolsim` but not here; an interrupted artefact upload retried under one idempotency key, which is proved in `apps/server/test/artefact-security.test.ts`; **redaction**, which is Stage 2 — the artefact inventory the run writes says so in the place a redaction assertion would go.

This scenario is release-blocking.

### 3.1 What runs automatically today

| Steps | Harness | Command |
|---|---|---|
| **1 to 15, over the deployed Compose stack** | `deploy/compose/e2e/run.sh` | `pnpm test:e2e` |
| 5 to 6, browser side | `apps/browser-worker/test/browser/` | `pnpm test:browser` |
| 8, annotation UI | `apps/web/test/ui/` | `pnpm test:ui` |
| 9 to 12, bespoke topology | `apps/mcp-server/test/integration/` | `pnpm --filter @reviewplane/mcp-server run test:integration` |
| 13, the human decision in a browser | `apps/web/test/ui/review-workspace.browser.test.ts` | `pnpm test:ui` |

The first row is the scenario itself and is the one §16's release condition
names. The rest are not redundant with it: each proves something the deployed
run cannot reach, and the deployed run proves the one thing none of them can —
that these components, in the images and under the network topology an operator
installs, complete the loop together.

`pnpm test:integration` runs steps 9 to 12 against real components — a real
PostgreSQL, the real control-plane process, the real MCP server, a real Chromium
browser worker in its own process, and the official MCP TypeScript SDK as the
client — but against a bespoke topology, with an administrator-issued
credential and no connector. `pnpm test:e2e` runs the same steps over the local
stdio bridge, through the edge gateway, with a real connector. The two answer
different questions and both are kept.

`pnpm test:ui` owns the halves that are properties of a **client**: that a mark
a human draws is recorded where they drew it, and that the accept request the
browser sends names the claim the page rendered rather than one it fetched when
the button was pressed. No server-side run can observe either.

A developer runs the whole scenario with one command, `pnpm test:e2e`, and needs
Docker and nothing else. On a failure the run prints the failing step, tails the
`api`, `tunnel-gateway`, `dev-fixture`, `browser-worker`, `mcp` and `gateway`
logs, and leaves `deploy/compose/e2e/evidence/` holding the agent fixture's own
log and JSON report, the event dump with sequence numbers and actor types, the
artefact inventory with recorded and read-back digests, the exported review
document, and screenshots at 390x844 and 1440x900. `REVIEWPLANE_E2E_KEEP_UP=1`
leaves the stack running for a look round.

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

"Verification requires evidence under policy" is split the same way.
`apps/server/test/completion-gate.test.ts` holds the pure half — requirement
evaluation against a project's viewports, missing-list construction, the
viewport comparison, `task_complete` result selection, the assurance split and
the gate function itself — and needs no database.
`apps/server/test/verification-evidence.test.ts` holds everything with a
stateful half: a real submission, supersession, the evidence-gated hand-over and
its denial event, the ownership and upload-completeness refusals, an unreachable
artefact store, the concurrency of two submissions on one finding, and the two
database backstops. Several of its assertions are on the **absence** of rows,
because the failure this work exists to prevent is a completion claim that was
recorded when it should not have been, and a test that only checked the response
code would pass against code that refused the caller and wrote the row anyway.

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
- A terminal finding status and an accepted review cannot be written by raw SQL
  without a human disposition actor, with the domain layer bypassed entirely. A
  constraint that only ever sees well-formed writes from its own code proves
  nothing
- An artefact belonging to another **finding** of the same project cannot be
  submitted as evidence. The project check does not catch it, because both
  findings are legitimately in scope

## 5. Control-lease tests

- Agent owns initial epoch
- Human takeover increments epoch
- Agent command with prior epoch is rejected
- Human disconnect expires lease safely
- Hand-back captures fresh state
- Duplicate control commands are idempotent
- Two users cannot both obtain lease
- System screenshot does not steal interactive lease

These live in `apps/server/test/browser-authority.test.ts`, except the two that
need human takeover — "human takeover increments epoch" and "hand-back captures
fresh state" — which arrive with Stage 2 (RVP-25). What is asserted in their
place is that `control/request` for a `human` controller is refused with
`UNSUPPORTED_CAPABILITY` **and audited**, so the absence is a recorded refusal
rather than a silent gap.

Every test in this group asserts **which side refused**. A refusal that reached
the worker and came back is not the same as one the control plane made, and only
the second satisfies the `SECURITY.md` §7 requirement that a command is
authorised before it reaches Chromium — so the assertion is that the worker
received no command request, not merely that the caller received a non-2xx.
Assertions about `browser.command_rejected` read the event store directly rather
than inferring the event from the error code, because the payload has no schema
and a denial that refuses correctly and records nothing would otherwise pass.

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
- A capability revoked with its route stays revoked when that route identifier is registered again, and across a restart of the gateway process
- A withdrawal the gateway cannot record durably is refused rather than performed
- The control API's authority: an operation the credential does not carry is refused, an enumeration returns only the credential's own organisation's routes, and every control action names the credential that made it
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

Revocation durability is proven where it is decided, in `services/tunnel-gateway`: `internal/registry/revocation_test.go` for the withdrawal set, and `internal/gatewayhttp/control_authority_test.go` for the same sequence through the whole gateway — publish, browse, revoke, re-register the identifier, present the original capability. `internal/gatewayhttp/restart_test.go` runs it **across a real process boundary**: the test binary re-executes itself as a gateway, the parent kills it, and a second gateway is started over the same journal. A restart expressed as a second object in one process would prove the journal is read and leave "does anything else carry the withdrawal across" answered by inspection.

Because that child runs no connector listener, its discriminator is which answer the authorisation path reaches: a capability that passes every check stops at `CONNECTOR_OFFLINE`, and a withdrawn one is refused earlier with `ROUTE_EXPIRED`. The test asserts a freshly minted capability reaches the first, so the second is about the withdrawal and not about a route that failed to come back. A test that asserted only a refusal would pass against a gateway that had simply lost the route.

A control-plane test MUST NOT assert that the gateway refuses a withdrawn capability. The gateway verifies from a signature without a database read, so what a double in `apps/server` can show is the **call** — the control plane's half — and asserting the refusal there would assert a property of a stub.

Connector reconnect is the Stage 0 exit criterion "Protocol round trip survives connector reconnect", and it is a three-part assertion rather than a single one: a request issued before the interruption succeeds, a request issued during it fails with `CONNECTOR_OFFLINE` or `PUBLISHED_SERVICE_UNAVAILABLE` and does not hang, and an equivalent request issued afterwards succeeds over the same `route_id` against the same destination with no operator action. A test making it MUST also show that no request was served by a different environment, which needs a second environment to be wrong about.

Running today: `services/connector/internal/protocolsim` (the Protocol simulation mode of `DEVELOPMENT.md` §4 — the three-part round trip, the six-field reconnect payload, routes closed on reconciliation, the desired-state timeout, flapping reconnects, the terminal upgrade classification, and the measured reconnect-time distribution over ten forced disconnects), `apps/server/test/connector-reconnect.test.ts` (a real connector process killed and restarted, a control-plane restart, claims on another connector's route, an expired route, a revoked identity, and browser sessions degraded and resumed) and `apps/server/test/reconciliation.test.ts` (the decision table).

### Publication authorisation and the agent surface

Running today: `apps/server/test/published-services.test.ts`, against a real
database, covering the endpoints of `docs/API.md` section 10 and — the part
that matters most — who may reach them. A cookie session must present its CSRF
token, and the refusal happens **before the body is decoded**, which the test
proves by sending a body that is **not JSON at all** and asserting the CSRF
refusal. The distinction is the point: a body that is valid JSON and fails
validation proves refusal before *validation*, which a `preHandler` guard also
achieves, and the test asserted exactly that while the documents claimed the
stronger property. Only a guard that runs before the parser can answer truncated
JSON.

Two more assertions belong to the same surface. A caller naming another
organisation's connector is refused identically to one naming no connector, and
the victim's route limit is untouched and its own publication still succeeds; a
caller naming another organisation's browser session is refused identically to
one naming no session, a mixed list of one reachable and one foreign session is
refused too, and no capability anywhere binds the foreign session. Both compare
whole normalised bodies rather than status codes. A route in another organisation answers
`DELETE` and capability minting **byte-identically** to a route that does not
exist, and the foreign route is still `ready` afterwards; a project in another
organisation answers the listing and the creation the same way, and writes no
row. Whole normalised bodies are compared rather than status codes, because a
status code alone would not catch a message that named what it had found. A
machine credential reaches none of the four routes.

`apps/mcp-server/test/development-services.test.ts` does the same for the tools
of `docs/MCP_SPEC.md` section 7.2, through a real MCP client: the advertised
input schema has no member for a connector, a project or a browser session; a
workspace in another project is absent rather than forbidden and identical to
one that does not exist; a route in another project is invisible to the listing,
absent to `development_service_unpublish` and untouched by the refusal; a
credential without `service:publish` may list and may not publish or revoke; and
a project with no connector answers `CONNECTOR_OFFLINE` rather than hanging.

`apps/server/test/session-service-binding.test.ts` covers the third caller: a
browser session binding to a route in another project is absent rather than
forbidden, and no capability is minted for it.

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

A read deadline is how cancellation reaches a goroutine parked in a socket read, and it MUST NOT be extended once that read's context has ended. The signal that carries the cancellation is one-shot — `context.AfterFunc` fires once — so anything that pushes the deadline forward afterwards parks the reader again for a whole idle window with nothing left to wake it. `internal/ws` therefore latches the read deadline under a mutex when the context ends and ignores every later extension, and `TestAPongHandlerCannotRevivePastACancelledRead` pins it. RVP-88 is what that costs: the connector's control channel installs a pong handler that restores the idle window, and it runs on the reading goroutine between frames, so a pong already in the socket buffer when cancellation landed re-armed a thirty-second wait and the protocol simulation's fifteen-second teardown bound tripped in roughly one full run in six under CPU contention. It presented as slowness and was not — 286 of 288 measured shutdowns finished within 19 ms and the other two did not finish at all. A shutdown bound of that shape is an assertion about cancellation and MUST NOT be widened to make it pass: no constant is large enough for a stall, and a larger one only hides it better.

A harness that bounds a shutdown MUST say what did not stop when the bound expires. It names the goroutines it is still waiting on and dumps every stack (`protocolsim.Harness.stallReport`), because a failure that needs multi-test process context and a loaded machine to appear at all cannot be diagnosed by reproducing it on demand; the stack at the instant the bound expires is the only evidence there will be, and a bare "it did not stop" throws it away.

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

Worker liveness, assignment refresh and session reconciliation are asserted in
`apps/server/test/browser-worker-liveness.test.ts` against a real database and
the stub worker, because they are control-plane behaviour and need no Chromium.
Two properties are asserted separately there because they fail separately: the
**sweep** makes the stored state honest, and the **liveness term in the query**
makes the decision safe for a worker that dies between two sweeps. The
scheduler test deliberately never runs the sweep — if it did, it would pass with
the liveness term removed and would be asserting the sweep twice.

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
- Agent forbidden transitions, refused **and audited**
- Idempotency conflict
- Capability degradation for clients without image support
- Inbox acknowledgement semantics
- Completion-gate missing evidence response

Every item on this list is covered by `apps/mcp-server/test/mcp.test.ts`, which
drives the endpoint with the official MCP TypeScript SDK client against a real
database. The completion-gate cases arrived with the tools they test (RVP-53):
the `missing` list emptying as an agent produces evidence, the hand-over refused
with `EVIDENCE_REQUIRED` and audited, `task_complete` answering
`blocked_missing_evidence` and then `blocked_pending_review` with
`terminates_session: false` and no finding moved, the assurance split never
letting an agent's assertion appear as a control-plane check, another project's
review and finding answered as unknown ones, and `project_current` and the gate
reporting the same configured viewports.

The suite also holds the properties that are specific to the agent surface: the
advertised tool set equals the schema's availability set; no advertised status
enumeration can express a final disposition; a slug from another project
resolves as not found; `review_search` cannot match another project's content
and has no project argument to widen it with; a wildcard in a search query is
matched literally rather than as a scan; an agent credential is refused by the
administrative API; a human session cookie is refused as agent authentication; a
credential that expires mid-session refuses the next call rather than executing
part of it; a transport session identifier is not a credential; and no tool
response carries a credential.

Two properties are asserted with the thresholds an adversarial review measured
rather than with a convenient fixture, because the convenient fixture is what
hid them. The bounded-response cases build a review with sixteen findings
carrying full-length text, twenty review comments of 3900 characters, and twelve
comments on one finding — the shapes at which `review_get` and `finding_get`
used to throw — and assert a shorter page, a cursor that reaches the rest with
no overlap, and that the finding and its evidence survive a long comment thread.
The authority cases assert one `finding.status_change_denied` per attempted
final disposition with the agent session as actor, one
`review.status_change_denied` for an attempted acceptance, and **no** record at
all when the attempt names another project's finding.

Inbox semantics are asserted at both ends. `apps/mcp-server/test/mcp.test.ts`
covers the agent's: an assignment delivers one item and a repeated assignment
delivers one; items are ordered oldest first; acknowledgement records receipt,
replays under one idempotency key and never sets a completion time; an item
delivered to another agent session answers `RESOURCE_NOT_FOUND`; and a reopened
finding delivers new work. `apps/server/test/inbox.test.ts` covers the human's:
acknowledgement and completion write different events, a cookie request with no
CSRF token changes nothing, an agent credential reaches none of the four routes,
and another project's item answers byte for byte as an unknown one does.

`apps/server/test/connector-agent-credentials.test.ts` covers the credential
exchange of ADR-0023 over real mutual TLS — `app.inject` cannot be used, because
the route's whole authentication is the verified client certificate on the
socket. `services/connector/internal/mcpbridge` covers the bridge's own half:
the notification's documented form, its refusal to carry a control character,
the status file's permissions and bound, the endpoint derivation, the proxy's
session capture, its JSON-RPC answer to an unreachable control plane, and its
refusal of an oversized message.

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
- Project A agent cannot **search** project B's reviews or findings
- Worker session credentials cannot call admin API
- Connector token cannot become human session
- A connector cannot report a workspace into a project it was not enrolled for
- A connector cannot claim a workspace identifier another project holds
- A connector cannot exchange its identity for a credential to another environment's workspace

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

### The organisation-wide session is the probe, not the project-scoped one

`apps/server/test/cross-tenant-authority.test.ts` covers the routes where a null
project scope was read as authority (RVP-91, RVP-92), and the **session shape it
uses is the requirement**. A guard of this class is invisible to both of the
probes that were available before it:

- a **project-scoped** session is refused correctly by the wrong predicate, so
  it passes against the defect and against the fix;
- the **bootstrap administrator** carries `organisationId: null` and
  `projectIds: null`, so every tenancy term in every scoped query goes vacuous
  and a missing one ships green.

So a suite covering a route that a signed-in person reaches MUST include an
**organisation-wide viewer of a different organisation** — a real sign-in, with
a real organisation and a real CSRF token — and MUST drive the route over its
transport rather than the service beneath it. It SHOULD keep the project-scoped
probe beside it rather than instead of it: the pair is what makes a mutation
test meaningful, because a term that is doing work fails the organisation-wide
probe while the project-scoped one still passes. A change that fails both is
refusing everything, which is a different change.

Asserted today: an organisation-wide viewer of one organisation cannot read
another's workspaces, and the refusal is **byte-identical** to an unknown
project identifier — equality of bodies, not of statuses — and discloses neither
the developer-machine `root_path` nor the victim's organisation identifier; the
same viewer cannot list the deployment's browser workers, cannot reassign one,
and the victim's assignment is intact afterwards; an assignment naming a project
that does not exist writes nothing, because the delete-then-insert would
otherwise strip the worker first; and the bootstrap administrator can still do
all of it.

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
| Control plane unavailable mid-agent-session | The call is refused with a stable code below the envelope rather than reported as a rejected credential; nothing is half-written; the same call succeeds once the database returns; the session ends `DISCONNECTED` rather than `COMPLETED` |
| Connector restart during a bridge session | The bridge ends with it and the next one requests a fresh credential; no token was stored to replay |
| Duplicate `agent_inbox_acknowledge` under one key | One acknowledgement and one event |
| Two agent sessions claiming one finding | One claim and one `VERSION_CONFLICT` |
| A review or finding whose ordinary content exceeds a tool's response bound | A shorter page and a cursor that reaches the rest, never a thrown error and never a retryable refusal |
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

`apps/server/test/upgrade-stage0.test.ts` runs the six steps above against that
fixture, in order, on every `pnpm test`:

| Step | What it does |
|---|---|
| Restore prior-version fixture | `psql --file database.sql` into an empty disposable PostgreSQL, and the fixture's artefact store onto a directory. Every per-table row count in the manifest is checked |
| Start new version | A pool from this build. The schema is asserted to be *behind* it, and the preflight of §12 of `docs/OPERATIONS.md` is run: `source_version` passes naming `0054`, and `backup_freshness` fails because nothing has been backed up. A backup is then taken — with the new build against the old schema, which is how upgrading from Stage 0 works — and the preflight passes |
| Apply migration | `migrate` applies exactly the pending set, `0055` to the head |
| Verify reviews and artefacts | `bugs-on-homepage` and its identifier, both findings with their statuses and severities, every annotation still normalised to 0–1, the agent's verification and its `after` artefact, and the bytes of all three screenshots digested against what the rows record. The review is also built into the portable document of `docs/REVIEW_FORMAT.md`, which is the same code the export and the UI read |
| Verify connector compatibility | `classifyUpgrade` against a Stage 0 connector version, in both directions: inside the shipped policy it is `compatible`; under a tightened minimum it is `upgrade_required`. The preflight's own check reads the same function |
| Verify rollback limitations | Every migration the upgrade applied is asserted to declare `not_supported` with a reason, and the pre-upgrade archive is then **restored** — into an empty database, with `--hostname` — and checked: the schema comes back at the Stage 0 head, the migrations the upgrade applied are reported pending, the review and all three artefacts are intact, and the `backup.restored` audit event is present. An earlier version asserted the archive's file size was greater than zero, which would have passed on a file of noise and never exercised the restore path below `0056` at all |

The upgraded installation is then backed up and restored into a third database,
with a new hostname, and its review, annotations and artefact bytes are checked
again. "The data survived the migration" and "the data can be got back out
again" are two different guarantees, and only the second is ever tested
deliberately.

## 14. Backup and restore tests

- Full backup and restore
- Database-only plus existing external artefact storage
- Missing key failure
- Corrupt archive detection
- Restore to new hostname
- Integrity hash verification

`apps/server/test/backup.test.ts` and `apps/server/test/backup-security.test.ts`
own these, against a real PostgreSQL and a real archive on disk. The cases that
matter are the refusals, so each is asserted as a refusal rather than as the
absence of a success:

| Required case | Assertion |
|---|---|
| Full backup and restore | An installation with a review, an annotated finding and a stored screenshot is archived and restored into an empty database; every table's row count matches the manifest, the annotation geometry is unchanged, and the evidence bytes are byte-for-byte identical |
| Database-only plus external storage | A `database` archive from an `s3` installation restores, reports the referenced artefacts as absent, and names the external store the manifest records rather than reporting corruption |
| Missing key failure | A canary private key is planted in `connector_tls_material` and every member of the archive is searched for it: absent by default, present only under `--include-key-material`. The exact warning text and the `key_material_included` value in the `backup.created` event are asserted on both paths. "Missing key" is the archive's disposition, not a restore failure — a restore without key material completes and reports the connector identities the missing authority invalidated |
| Corrupt archive detection | An archive rebuilt with one member's bytes altered, and one member added that the manifest does not declare: each is refused. Truncation is asserted as the invariant rather than as an error — a truncated archive is refused or read whole and never read short — at five cut points, because Node's `zstd` decompressor ends cleanly on an incomplete frame and the guarantee is the archive reader's alone. A truncated archive is refused **before** the target gains a schema |
| Restore to new hostname | `--hostname` revokes the sign-in sessions issued for the previous host, reports the settings to change, and records `hostname_changed` in the audit event |
| Integrity hash verification | Every member is checked against the manifest's digest and size in a pass that writes nothing; a size or digest disagreement is an `ArchiveIntegrityError` |

The fault-injection cases RVP-56 requires are covered in the same file, and are
additional to §11's matrix rather than rows of it: an interrupted write leaves
neither the destination nor the `.partial` file behind; a load that would leave
a dangling reference aborts and leaves no row; a migration lock held by another
process is reported rather than waited on; an artefact referenced by metadata
but absent from the store is reported by both the backup and the restore instead
of being passed over; and a restore that fails leaves the database exactly as
it found it, because its migrations run inside its own transaction and roll back
with everything else. That last case is asserted against the objects an
emptiness check cannot see — a view, a function, a sequence, a type and an
extension in `public`, all still present after a forced failure — and by a
retry that then succeeds.

Two cases exist because they were defects rather than because they were
foreseen. **Text is round-tripped byte for byte** through content chosen so that
multi-byte characters straddle decompressor chunk boundaries — decoding each
chunk alone replaced them with U+FFFD, silently, with row counts unchanged.
**An archive from an older schema is restored to completion**, with and without
`--hostname`: every step after the load runs against the archive's schema, not
this build's, and against a `0054` archive `event_outbox`, `install_tokens` and
`viewer_sessions.revocation_reason` do not exist.

The negative security tests are separate on purpose: restore is reachable
through no route the control plane registers, and the assertion enumerates
Fastify's own route table rather than guessing paths.

## 15. UI and accessibility tests

- Keyboard navigation
- Focus order
- Screen-reader names
- Reduced motion
- Annotation list alternative
- Responsive layouts at 390x844 and 1440x900
- Browser live surface reconnect
- Before-and-after comparison

Annotation **capture** is proved in `apps/web/test/ui/capture.browser.test.ts`,
which owns the flow of `UX_FLOWS.md` §9 and §10 end to end: capture, draw,
describe, group, name. It is a separate suite from the one below because the two
prove different things — that suite proves a **stored** overlay aligns, this one
proves a mark a human **draws** is recorded where they drew it.

Its shape is the same, and for the same reason: every alignment case measures
the mark against the picture and samples the screenshot's own colour underneath
it, so a mark that drifts by a few per cent lands on the background and fails.
The conditions are 390x844 and 1440x900 at device pixel ratios 1 and 2, plus a
window resize, an in-page container resize, a scroll and a ratio of 3. Crossing
both ratios is what makes the suite catch a stray `devicePixelRatio`
multiplication: at a ratio of 1 such a bug is invisible, and removing the
ratio-2 cases would leave a suite that passes with one in place.

Three further properties are asserted because each fails on its own. The
**request the bundle actually sent** is read out of the stub and checked for
normalised geometry, the whole §9 captured-context list and the absence of a
`source` claim — a test that asserted on a component's arguments would pass with
the request never leaving the page. The **keyboard case** places a mark with no
pointer at all and asserts the geometry it produced, reaching the toolbar by
`Tab` rather than by `focus()` because `:focus-visible` is what draws the ring.
The **annotation list** is asserted to state each mark's position and shape as
text, for all six types including freehand, so the non-canvas alternative is
proved to convey the same information rather than merely to exist.

Two fault injections of section 11 run here: a capture whose upload never
completed reaches the "Evidence upload incomplete" state and creates no draft,
and a slug already in use is refused with an action the reader can take while
the drafts survive the refusal.

Annotation alignment of a stored overlay is proved in
`apps/web/test/ui/annotation.browser.test.ts`, which owns the Stage 0 exit
criterion "a screenshot annotation aligns after UI resize". Every case measures two things and requires them to agree: where the
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

Agent delivery state is proved in `apps/web/test/ui/agent-delivery.browser.test.ts`,
which owns the review page's Agent delivery section (`UX_FLOWS.md` §11 and §15).
Its three delivery-state cases run at both required viewports and it is built
around the three ways that section can lie. A
delivered review must state the agent-session identifier it was assigned to, its
inbox status as a word beside the badge, and "not yet received" while the item is
pending — an assignment is not a collection, and asserting the third alongside
the first is what keeps them apart. An acknowledged item must state the time it
was collected, which is why the browser context pins both locale and time zone:
an unpinned zone would make the assertion depend on where the container thinks
it is. An undelivered review must render its named empty state and must state
none of the five inbox statuses anywhere in the section, so a status invented out
of an absence fails rather than passing quietly. One further case proves the
command block and its copy control are reachable by keyboard with visible focus
and that the announced outcome is one of the two honest ones, and another proves
that a browser with no clipboard gets a disabled control and the keyboard route
rather than a thrown error. Every case also asserts that the page states
ReviewPlane does not type into an agent's terminal, because §11's prohibition is
on a claim and only an affirmative sentence can be tested for.

The review workspace is proved in
`apps/web/test/ui/review-workspace.browser.test.ts`, which owns
`UX_FLOWS.md` §12, §13 and §16 and the half of the product's central invariant
no server test can reach.

`apps/server/test/accept-evidence-integrity.test.ts` proves that the control
plane refuses an accept carrying a superseded claim, and says in its own header
what it cannot prove: that a **client** sends the claim it rendered rather than
one it fetched when the button was pressed. This suite is where that is
observable. The comparison is opened, the stub supersedes the evidence
underneath it as an agent would, Accept is pressed, and the request the browser
actually sent is read out of the stub's transcript and asserted to name the
claim the page rendered — with the negative assertion beside it that it is not
the identifier that replaced it. A test asserting only that the refusal
appeared would pass for a client that had sent the wrong thing to a server that
refused it for the wrong reason.

Three further properties are asserted against the **rendered DOM** rather than
against component source, because each has a source-level shape that looks
correct and is not. The §13 assurance split is taken apart by the accessible
text of its two groups, including the visually hidden words a screen reader
announces for each row, so two arrays rendered through one list with one marker
fails. An agent summary carrying markup is asserted both to be on screen
character for character **and** to have produced no element and set no global —
a page that stripped it would satisfy the second alone while having changed what
was stored. Statuses are read out of their badges as words.

Accept and reopen each run at 1440x900 and 390x844, `UX_FLOWS.md` §20 requiring
accepting findings to work on a phone, and the mobile case additionally asserts
that the document does not scroll horizontally. Keyboard navigation reaches the
decision controls and the claim list by `Tab` rather than by `focus()`, because
`:focus-visible` is what draws the ring, and the outline is measured. The
review-level case asserts both halves of "offering is not granting": a review at
`READY` is offered no decision because the transition table permits none, and a
review at `AWAITING_HUMAN_REVIEW` is offered accept and refused it while a
human-authored finding is outstanding.

`apps/web/test/review-actions.test.ts` runs under `pnpm test` and covers the
derivation itself: every decision the workspace offers is compared against the
protocol transition table for every status on both sides of it, so a view model
that hard-coded a list would fail where the two disagreed. Its negative half —
that an agent is offered no disposition from any status — is the product
invariant read out of the table rather than asserted about it.

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

One of the conditions above now has an owner that runs on every pull request:
**"migration or restore test fails"** is `apps/server/test/upgrade-stage0.test.ts`
and `apps/server/test/backup.test.ts`, both inside `pnpm test`. A migration that
breaks the committed Stage 0 fixture, and a restore that stops reproducing what it
was given, fail the build rather than the release.

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

`CI gates` and `Harness gates` are the two status checks required on `main`
(AGENTS.md, "Change delivery"). The `protect main` ruleset lists both, so a pull
request whose gates are red cannot be merged rather than merely showing that it
should not be. Both are workflow-level rollups for this reason: exactly two
entries are required, and neither has to be revised when a job is added to or
renamed inside its workflow.

Requiring them depends on a property of `Harness gates` that is easy to lose. It
reports green on a documentation-only pull request rather than being skipped,
recording in the run summary which files led to that verdict. A workflow that
`paths` filtered itself out would report nothing, and a required check that never
reports blocks every merge for ever — so the documentation-only decision MUST
stay inside the workflow, as section 16.1 already requires.

`pnpm test:install` owns two of the conditions above: it runs
`docs/DEPLOYMENT.md` section 8 verbatim from a clean checkout to a rendered
login page, which is the Stage 1 exit criterion "fresh installation from
release artefacts in one documented flow", and it asserts that the browser worker
is not running with unsupported insecure defaults — non-root, sandbox enabled as
the worker itself reported it at registration, no Docker socket, no database or
artefact credential, and no published debugging port. The remaining conditions
have no automated owner. RVP-57
builds the release pipeline that makes every condition above blocking, and the
list here is its specification rather than a description of what runs today.

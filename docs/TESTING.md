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

### Contract

- TypeScript and Go schema compatibility
- MCP tool schema snapshots
- Connector message compatibility
- Event payload compatibility
- API OpenAPI compatibility

Contract tests for a protocol run one committed fixture corpus in every language that speaks it. For the connector protocol that corpus is `packages/protocol/fixtures/connector/v1/`: its manifest lists the frames that must be accepted, with their canonical encodings, and the frames that must be refused, with the reason each must report. `pnpm protocol:check` runs the corpus in both languages and additionally fails when either language's generated models differ from the schema source, which is the snapshot test for an unreviewed schema change.

### Integration

- API, PostgreSQL and both artefact-store drivers
- Browser worker and tunnel gateway
- Connector and loopback dev server
- MCP client and review retrieval
- WebSocket live frames and control

Running today: `apps/server/test/connector-integration.test.ts` (enrolment, channel, revocation, and the `ss -ltnp` evidence that the connector opens no listening socket) and `apps/server/test/route-publication.test.ts` (route publication end to end through the real connector binary and a real loopback service, including `PORT_NOT_LISTENING` after the bounded grace, `DESTINATION_NOT_ALLOWED`, `PROJECT_NOT_AUTHORISED`, `CONNECTOR_OFFLINE` and `ROUTE_EXPIRED`). Both build `services/connector` from source, so neither can drift from the binary an operator runs.

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

Steps 1 to 6 run automatically as `pnpm test:e2e` (`deploy/compose/e2e/run.sh`). It starts the Compose stack, enrols the connector fixture, starts the fixture application on connector loopback, publishes it, reserves and allocates a browser session against the route, and navigates central Chromium to the internal origin. Every step asserts its own outcome and a step that cannot be verified aborts the run; evidence lands in `deploy/compose/e2e/evidence/`.

Steps 7 to 15 need reviews, findings, verification and export, and arrive with the issues that introduce them.

This scenario is release-blocking.

## 4. Domain tests

Required transition tests:

- Agent cannot accept human finding
- Human can reopen resolved finding
- Accepted review cannot mutate silently
- Finding claim uses optimistic version
- Review slug uniqueness is project scoped
- Staleness warning does not auto-close finding
- Verification requires evidence under policy

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
- Connector reconnect
- Route expiry
- Revocation during active stream
- Destination host substitution rejected
- Cross-project capability rejected
- Link-local and metadata destination rejected
- Stream and memory limits
- Malformed frames
- Slow consumer and backpressure

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

## 11. Fault-injection matrix

| Failure | Expected behaviour |
|---|---|
| Connector disconnect during navigation | Action fails clearly, route unavailable, session remains diagnosable |
| Worker crash after screenshot upload | Uploaded evidence remains, session marked failed |
| API restart during live view | Client reconnects and refreshes state |
| Database unavailable | State changes denied; no unaudited continuation |
| Artefact store unavailable | Verification remains incomplete |
| Human takeover during agent click | Ordered lease transition, no concurrent input |
| Duplicate verification request | One verification record through idempotency |
| Retention deletion partial failure | Retry, metadata not falsely tombstoned |

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

## 13. Upgrade tests

For each supported upgrade path:

- Restore prior-version fixture
- Start new version
- Apply migration
- Verify reviews and artefacts
- Verify connector compatibility
- Verify rollback limitations

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

## 16. Release gates

A release cannot ship when:

- Primary end-to-end scenario fails
- Cross-project isolation tests fail
- Stale control commands are accepted
- Migration or restore test fails
- Browser worker runs with unsupported insecure defaults
- Critical dependency vulnerability lacks documented mitigation
- Protocol compatibility tests fail

# Development Guide

## 1. Intended repository structure

```text
apps/
  web/
  server/
  mcp-server/
  browser-worker/
services/
  connector/
  tunnel-gateway/
packages/
  domain/
  protocol/
  sdk/
  ui/
  config/
deploy/
  compose/
  helm/
  airgap/
docs/
examples/
test/
  fixtures/
```

The exact structure may be refined before code is created, but separation between control plane, browser execution and connector must remain.

Existing today: `packages/protocol` (pnpm workspace member and Go module `github.com/danjonesio/reviewplane/packages/protocol`), `apps/server` (pnpm workspace member `@reviewplane/server`: control-plane HTTP API, connector channels, published services, browser-session orchestration, artefacts, reviews and agent sessions), `apps/mcp-server` (`@reviewplane/mcp-server`: the agent-facing MCP endpoint), `apps/browser-worker` (`@reviewplane/browser-worker`), `apps/web` (`@reviewplane/web`), `services/connector` (Go module `github.com/danjonesio/reviewplane/services/connector`), `services/tunnel-gateway` (Go module `github.com/danjonesio/reviewplane/services/tunnel-gateway`), `examples/dev-fixture` and `deploy/compose` (including the edge that serves the web build output). `test/fixtures/` holds committed data fixtures that belong to no single package: `test/fixtures/stage0` is the frozen Stage 0 installation the Stage 1 upgrade test restores (`docs/TESTING.md` §13). The workspace root carries `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js` and `go.work`. Go modules are listed in `go.work` so that a service resolves `packages/protocol` from the working tree rather than from a tag; add each new module there as it is created.

Inside a TypeScript application: `src/main.ts` is a thin entry point, `src/app.ts` (or `src/worker.ts`) is composition only, and domain code lives in `src/modules/<domain>/`. Shared files at `src/` are kept to the few things every module needs — configuration, identifiers, errors, authentication, events and the database pool. Migrations are plain SQL in `apps/server/migrations`, applied in lexical order exactly once by the runner in `src/db/migrate.ts`, which records applied file names in `schema_migrations`.

## 2. Toolchain direction

- TypeScript with strict mode
- pnpm workspaces
- Vite React SPA with TanStack Router and Query for web
- Tailwind CSS
- Playwright
- Go for connector and tunnel-heavy service
- PostgreSQL
- Pluggable artefact store: filesystem driver default, S3-compatible driver optional
- Docker Compose

Pin tool versions in repository-managed files. Avoid relying on globally installed tooling beyond Docker and the chosen package managers.

## 3. Shared schemas

`packages/protocol` is the source for:

- API request and response schemas
- MCP tool inputs and outputs
- Event payload schemas
- Connector protocol messages
- Stable error codes

Generate or validate Go and TypeScript models from one versioned source. Do not hand-maintain structurally equivalent types in several services.

The mechanism is ADR-0013. Each protocol version has one machine-readable source — for the connector protocol, `packages/protocol/schemas/connector/v1.schema.json` — from which `pnpm protocol:generate` renders the committed TypeScript and Go. `pnpm protocol:check` re-renders both in memory and fails when a committed file differs, so a change made in one language alone cannot land. It also runs the committed cross-language fixture corpus and the Go test suite. The Go toolchain is required for both commands, because the generator formats its Go output with `gofmt`.

Connector-protocol messages, browser-worker messages (`packages/protocol/schemas/browser/v1.schema.json`), live-view messages (`packages/protocol/schemas/live_view/v1.schema.json`), the review domain (`schemas/review/v1.schema.json`), the MCP interface (`schemas/mcp/v1.schema.json`) and the platform foundation (`schemas/platform/v1.schema.json`) are implemented today. The platform source is where the API envelope, the stable error codes, the opaque entity identifier, the pagination cursor, the event envelope and the project event-stream messages live, and it renders both TypeScript and Go.

The Go runtime the generated packages need — the validation and decoding primitives, the canonical writer and the redacted string type — is itself rendered, from the templates in `packages/protocol/tools/go-runtime/`. A second Go-rendering source would otherwise need a byte-identical hand-maintained copy of it, and two copies of a canonical encoder is exactly the drift ADR-0013 exists to prevent.

Each schema source declares the languages it renders in its own `x-protocol.languages`, and `pnpm protocol:check` compares exactly that set. The browser-worker protocol declares `["typescript"]`: both its parties, `apps/server` and `apps/browser-worker`, are TypeScript, so a Go rendering would have no consumer. Declaring the set keeps the ADR-0013 guarantee exact rather than weakening it — when a Go component needs those messages the field changes and the check starts failing until the Go is committed.

## 4. Local development modes

### Full Compose

Runs PostgreSQL, gateway, server, MCP, browser worker and tunnel gateway. Artefacts use the filesystem driver on a local volume; add an S3-compatible service only when exercising the `s3` artefact driver.

### Hybrid

Runs data services in Compose and application processes locally for rapid iteration.

### Connector fixture

A local connector instance publishes a fixture application bound to loopback.

### Protocol simulation

Test harness simulates connector and worker clients for failure cases without launching a full browser.

Running today: `services/connector/internal/protocolsim` assembles a control plane, the gateway role of the data channel, a real connector and two loopback development services in one process, and severs the channels deterministically. It exists because a distributed protocol that has never been interrupted in a test has not been tested, and because the three-part round-trip assertion of `TESTING.md` §6 needs a request before an interruption, one during it and one after it, against a route whose destination is known — a browser adds nothing to that and makes it slow. It runs under `go test ./...` in `services/connector` and needs no Docker.

Set `REVIEWPLANE_EVIDENCE_DIR` when running it to have the transcript, the reconciliation log and the reconnect-time distribution written out as files rather than only logged.

## 5. Recommended commands

Future root scripts should converge on:

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm protocol:check
pnpm docs:check
```

Go services:

```bash
go test ./...
go vet ./...
```

Prefer root orchestration commands that run the correct service-specific tooling.

Working today at the repository root: `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:browser`, `pnpm test:ui`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:edge`, `pnpm test:install`, `pnpm protocol:generate` and `pnpm protocol:check`. `go test ./...`, `go test -race ./...` and `go vet ./...` run from a module directory: `packages/protocol`, `services/connector` or `services/tunnel-gateway`. The remaining scripts arrive with the surfaces they exercise.

`pnpm test` needs Docker: the `apps/server` suite starts a disposable PostgreSQL and removes it afterwards, because the artefact, event and published-service behaviour it covers is only meaningful against the real database. Set `REVIEWPLANE_TEST_DATABASE_URL` to run against an existing database instead. The connector integration test additionally builds `services/connector` from source, so the Go toolchain must be available too.

It runs workspace packages at pnpm's default concurrency. The serial bound (`--workspace-concurrency=1`) that briefly guarded this gate existed only to make a then-present fixture defect report honestly; RVP-62 fixed the defect (database readiness is now probed over the transport the tests use, the reset cannot deadlock, and a failing setup exits with a summary), so the bound was removed rather than left to slow every run for a reason that no longer exists.

`pnpm test:browser` is separate because it needs a Chromium and its system libraries, and because `docs/SECURITY.md` section 10 requires the Chromium sandbox to be enabled. It builds the worker image and runs the suite inside it under the same container controls `deploy/compose/compose.yaml` applies — non-root, `cap-drop ALL` plus `SYS_CHROOT`, the committed seccomp profile, and no network beyond the explicit internal networks the case under test needs — so a green run is evidence about the deployed posture rather than about a developer's machine.

`pnpm test:e2e` runs `deploy/compose/e2e/run.sh`, the end-to-end scenario of `docs/TESTING.md` §3 steps 1 to 6: it brings up the Compose stack, enrols the connector fixture, starts the fixture development services on loopback, publishes them, starts browser sessions and navigates to them. It then proves the tunnel capabilities `docs/ARCHITECTURE.md` §7.4 makes mandatory — a WebSocket echo, server-sent events with their arrival timing, and Vite hot module replacement applying a source edit made on the development machine without a full page reload — and records the performance baseline of `docs/TESTING.md` §12. It needs Docker and roughly four minutes.

Each run takes its own Compose project name, so two runs on one machine do not share containers, networks or volumes; built images carry a fixed name so that a per-run project does not leave a copy of every image behind. `deploy/compose/README.md` records both and how to override them.

`pnpm test:edge` runs `deploy/compose/e2e/edge-smoke.sh`: it builds and starts the edge gateway alone, on its own Compose project and an ephemeral host port, and asserts from outside over TLS that `/healthz` answers, that `/` serves the application document, that `/internal/*` is refused and that the security headers are present and the `Server` header is not. It exists because every other suite runs *behind* the gateway, so nothing else fails when the gateway itself does; it needs Docker and about half a minute. It starts no upstream — `/api`, `/ws` and `/mcp` are driven to real peers by `pnpm test:install` — but it does assert that every `reverse_proxy` target in the Caddyfile names a service that exists in `compose.yaml`, because a rename that misses the routing file leaves all three silently serving the application document.

`pnpm test:install` runs `deploy/compose/e2e/install-smoke.sh`: it materialises a clean copy of the repository — `git ls-files`, so no `node_modules`, no build output and no generated secret — and runs `docs/DEPLOYMENT.md` §8's commands **verbatim** in it, then asserts what the installation is supposed to be true of. It reaches a login page over TLS through the gateway, drives `/api` and `/mcp` to their real upstreams, port-scans the host for PostgreSQL and the Chromium debugging port, inspects every container for a Docker socket, reads the browser worker's uid and its registered sandbox posture, and injects three faults: PostgreSQL stopped, an unwritable artefact store and a missing secret file. It is the gate for the Stage 1 exit criterion "fresh installation from release artefacts in one documented flow", and it needs Docker and roughly twenty minutes on a small host, because it builds every image. Evidence lands in `deploy/compose/e2e/evidence-install/`.

`pnpm test:integration` runs steps 9 to 12 of the primary end-to-end scenario (`docs/TESTING.md` section 3.1): a real PostgreSQL, the real control-plane process, the real MCP server, a real Chromium browser worker in its own process, and the official MCP TypeScript SDK as the client. It runs in the same worker image under the same controls as `pnpm test:browser`, on an internal Docker network whose only reachable peer is its own database, with a unique name per run so two can run at once.

`pnpm test:ui` runs the user-interface and accessibility suite of `docs/TESTING.md` section 15. It builds the web bundle and drives it in the same image, for the same reason: the repository has one Chromium and keeping a second in step would be a liability rather than a convenience. `pnpm build` for `apps/web` also fails when the produced bundle would reach an external host, so a green build is part of the ADR-0011 no-CDN guarantee.

### 5.1 Continuous integration

`.github/workflows/ci.yml` runs the root gates above on every pull request and on every push to `main`: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm protocol:check`, `pnpm test`, and `go vet ./...`, `go test ./...` and `go test -race ./...` in each of `packages/protocol`, `services/connector` and `services/tunnel-gateway`. Each gate is its own job so that a failure names itself, and the `CI gates` job is green only when all of them are; it is the status check to require on `main`. A change MUST NOT be merged with a failing gate, and a workflow MUST NOT add a build or generation step the commands do not need — `pnpm typecheck` and `pnpm test` work on a fresh clone, and a workflow that hid that would stop reporting when it stopped being true.

The container harnesses cost minutes rather than seconds, so `.github/workflows/container-harnesses.yml` runs `pnpm test:browser`, `pnpm test:ui`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:edge` and `pnpm test:install` nightly and on demand rather than on every pull request. A pull request whose change touches the browser worker, the annotation UI, the MCP integration path, the Compose stack or the edge gateway SHOULD carry the `ci:harnesses` label, which runs them for that pull request. Turning `docs/TESTING.md` section 16 into a release pipeline is RVP-57; these two workflows are the part of it that can run on every change today.

Every action is pinned to a commit rather than a tag, because a tag is mutable and `docs/SECURITY.md` section 19 requires a pinned supply chain. Tool versions come from the files that declare them rather than from the workflow: pnpm from `packageManager` in `package.json` and Go from `go.work`. Node is the exception and names its major, because `engines.node` is the open range `>=24.0.0` and a workflow that resolved it would adopt the next major on its release day.

## 6. Configuration

- Commit `.env.example`, never real secrets
- Use secret files in Compose
- Provide deterministic local defaults
- Validate configuration at startup
- Fail with specific errors
- Document every setting and default

## 7. Database migrations

- Forward-only by default
- Transactional where supported
- Versioned and reviewable
- Tested against realistic previous-version fixtures — the Stage 0 one is
  committed at `test/fixtures/stage0/` (`docs/TESTING.md` §13)
- Do not perform expensive unbounded data migration during ordinary service startup without progress visibility

Files are named `NNNN_lower_snake_case.sql`, so lexical order is apply order and
two migrations written on different branches cannot claim an ambiguous
position. `reviewplane migrate` applies them and reports the schema version
(`docs/DEPLOYMENT.md` §11); `reviewplane migrate --status` reports what is
pending without changing anything. The upgrade path is tested rather than
assumed: `apps/server/test/platform-foundation.test.ts` migrates a database to
the previous stage's head, seeds it as that stage would have, and then applies
the newer migrations on top, and `apps/server/test/upgrade-stage0.test.ts` does
the same against the committed Stage 0 installation (`docs/TESTING.md` §13).

Every migration MUST state whether it can be undone, on its own comment line:

```sql
-- downgrade: not supported (forward-only; roll back by restoring the backup taken before the upgrade)
```

`docs/DEPLOYMENT.md` §15 requires the statement, `reviewplane migrate --status`
prints it for every pending migration, and
`apps/server/test/migrate.test.ts` fails when a committed migration does not
carry one. A file with no declaration is *read* as `not supported`, which is the
default above; the test exists so that the default is a safety net rather than a
way to skip the statement. Nothing in Stage 1 implements automated downgrade, so
`not supported` means the way back is the pre-upgrade backup.

## 8. API development

- Schema-first
- Stable error codes
- Authorisation in service layer, not UI
- Idempotency on retried commands
- Optimistic concurrency on reviews and findings
- Request IDs in logs and responses

## 9. Browser-worker development

- Never run with host Docker socket
- Use fixture applications for deterministic tests
- Keep browser-command layer separate from domain orchestration
- Validate control epoch for every interactive command
- Treat snapshots and page text as untrusted
- Bound all logs and snapshots

In `apps/browser-worker` these read as:

- `src/session/commands.ts` is the browser-command layer. It takes a session and a protocol command and returns a protocol result; it knows nothing about the control plane beyond an artefact-uploader interface, which is what lets the component tests drive it against `test/browser/fixture-app.ts` with no server running.
- `src/session/control.ts` holds the epoch and lease arithmetic as pure functions, so the checks are unit-testable and the command path cannot skip one.
- Page-derived strings pass through `src/session/untrusted.ts` before they reach a protocol validator or a log line. A page controls the length and byte content of its own titles and labels, so those are bounded and stripped of control characters at the boundary.
- Every wait is bounded. Where Playwright provides no timeout — `page.evaluateHandle`, which runs the snapshot walk inside the page — the worker imposes one, because otherwise the page decides how long a command takes.
- Element references resolve through Playwright handles held in the worker process, never through a marker written into the page and never through a global the page can reach. A page can detach the node, which makes the interaction fail; it cannot make a reference point somewhere else.

## 10. Connector development

- Protocol parser uses bounded allocations
- Reconnect logic has jittered backoff
- Private key permissions validated
- No broad workspace scanning by default
- No terminal scraping or input injection in MVP
- Tunnel destination cannot be changed by remote browser data

## 11. UI development

- Keyboard accessibility
- Responsive at 390x844 and 1440x900
- Annotation geometry tested under zoom, resize and device-pixel ratio
- Avoid colour-only state indication
- Live streams degrade without breaking review workflows
- Original evidence remains available when overlay rendering fails

In `apps/web` these read as:

- `src/live/client.ts` is the live channel and holds no React. Reconnect,
  stall detection and the pairing of frame metadata with the binary message
  that follows it are testable without a browser, and a later overlay renderer
  gets the frame's declared dimensions and sequence from the same place.
- Live frames are drawn into a canvas as decoded images. Page-derived content
  is never inserted as markup, and a page-derived URL is rendered as text
  rather than as a link (ADR-0010).
- "Degrades without breaking" is specific: a failed or stalled stream shows a
  named cause from `docs/UX_FLOWS.md` section 18 over the last frame, states
  that navigation and screenshot capture still work, and offers a reconnect.
- Reduced motion is answered by running the stream in the low-rate mode and
  saying so, not only by disabling CSS transitions.
- `src/components/AnnotationOverlay.tsx` converts coordinates exactly once, at
  its edge: the stage's measured box becomes a content rectangle, and
  normalised geometry is placed inside it. Nothing between those two steps
  multiplies by a device pixel ratio or reads an intrinsic pixel size, which is
  why the overlay survives a container resize, a zoom, a scroll and a
  device-pixel-ratio change. The arithmetic is
  `@reviewplane/protocol/review`'s, shared with the server that validates the
  same geometry.
- "Original evidence remains available when overlay rendering fails" is
  specific too: `ArtefactViewer` names the cause — an artefact the server could
  not measure, or a renderer failure caught by its error boundary — and keeps
  the screenshot and the annotation list on screen. The annotation list is a
  peer of the canvas rather than a fallback, so it is always rendered.

## 12. Feature flags

Feature flags may gate incomplete optional features, but must not silently alter security behaviour. Security-relevant flags require explicit names, warnings and audit events.

## 13. Documentation workflow

When changing behaviour:

- Update the normative document
- Update examples
- Update ADR if decision-level
- Validate internal links
- Keep terminology consistent with glossary

## 14. Pull-request checklist

- [ ] Product requirement identified
- [ ] Trust boundaries considered
- [ ] Domain invariants preserved
- [ ] Protocol schema updated
- [ ] Backwards compatibility assessed
- [ ] Tests added
- [ ] Failure behaviour tested
- [ ] Logs and metrics added
- [ ] Documentation updated
- [ ] Browser evidence attached for UI changes

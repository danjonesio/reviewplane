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
```

The exact structure may be refined before code is created, but separation between control plane, browser execution and connector must remain.

Existing today: `packages/protocol` (pnpm workspace member and Go module `github.com/danjonesio/reviewplane/packages/protocol`), `apps/server` (pnpm workspace member `@reviewplane/server`: control-plane HTTP API, connector channels, published services, browser-session orchestration and artefacts), `apps/browser-worker` (`@reviewplane/browser-worker`), `services/connector` (Go module `github.com/danjonesio/reviewplane/services/connector`), `services/tunnel-gateway` (Go module `github.com/danjonesio/reviewplane/services/tunnel-gateway`), `examples/dev-fixture` and `deploy/compose`, plus the workspace root that carries `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js` and `go.work`. Go modules are listed in `go.work` so that a service resolves `packages/protocol` from the working tree rather than from a tag; add each new module there as it is created.

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

Connector-protocol messages and browser-worker messages (`packages/protocol/schemas/browser/v1.schema.json`) are implemented today. API, MCP and event schemas join the package as the issues that introduce those surfaces land.

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

Working today at the repository root: `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:browser`, `pnpm test:e2e`, `pnpm protocol:generate` and `pnpm protocol:check`. `go test ./...`, `go test -race ./...` and `go vet ./...` run from a module directory such as `packages/protocol`, `services/connector` or `services/tunnel-gateway`. The remaining scripts arrive with the surfaces they exercise.

`pnpm test` needs Docker: the `apps/server` suite starts a disposable PostgreSQL and removes it afterwards, because the artefact, event and published-service behaviour it covers is only meaningful against the real database. Set `REVIEWPLANE_TEST_DATABASE_URL` to run against an existing database instead. The connector integration test additionally builds `services/connector` from source, so the Go toolchain must be available too.

`pnpm test:browser` is separate because it needs a Chromium and its system libraries, and because `docs/SECURITY.md` section 10 requires the Chromium sandbox to be enabled. It builds the worker image and runs the suite inside it under the same container controls `deploy/compose/compose.yaml` applies — non-root, `cap-drop ALL` plus `SYS_CHROOT`, the committed seccomp profile, and no network beyond the explicit internal networks the case under test needs — so a green run is evidence about the deployed posture rather than about a developer's machine.

`pnpm test:e2e` runs `deploy/compose/e2e/run.sh`, the end-to-end scenario of `docs/TESTING.md` §3 steps 1 to 6: it brings up the Compose stack, enrols the connector fixture, starts the fixture development service on loopback, publishes it, starts a browser session and navigates to it. It needs Docker and roughly two minutes.

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
- Tested against realistic previous-version fixtures
- Do not perform expensive unbounded data migration during ordinary service startup without progress visibility

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

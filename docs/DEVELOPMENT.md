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

Existing today: `packages/protocol` (pnpm workspace member and Go module `github.com/danjonesio/reviewplane/packages/protocol`), `apps/server` (pnpm workspace member `@reviewplane/server`: control-plane HTTP API, connector channels, published services and browser-session orchestration), `services/connector` (Go module `github.com/danjonesio/reviewplane/services/connector`) and `services/tunnel-gateway` (Go module `github.com/danjonesio/reviewplane/services/tunnel-gateway`), plus the workspace root that carries `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js` and `go.work`. Go modules are listed in `go.work` so that a service resolves `packages/protocol` from the working tree rather than from a tag; add each new module there as it is created.

`apps/server` is organised so that domains can land independently: `src/main.ts` is a thin entry point, `src/app.ts` is composition only, and each domain lives under `src/modules/<domain>/`. Migrations are plain SQL in `apps/server/migrations`, applied in lexical order exactly once by the runner in `src/db/migrate.ts`, which records applied file names in `schema_migrations`.

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

Connector-protocol messages are implemented today. API, MCP and event schemas join the package as the issues that introduce those surfaces land.

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

Working today at the repository root: `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm protocol:generate` and `pnpm protocol:check`. `go test ./...`, `go test -race ./...` and `go vet ./...` run from a module directory such as `packages/protocol`, `services/connector` or `services/tunnel-gateway`. The remaining scripts arrive with the surfaces they exercise.

`apps/server`'s component tests need PostgreSQL. They start a disposable container and remove it afterwards, including on an abnormal exit; set `REVIEWPLANE_TEST_DATABASE_URL` to run them against an existing database instead. The connector integration test additionally builds `services/connector` from source, so Docker and the Go toolchain must both be available to run `pnpm test`.

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

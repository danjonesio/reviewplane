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

## 2. Toolchain direction

- TypeScript with strict mode
- pnpm workspaces
- Astro and React for web
- Tailwind CSS
- Playwright
- Go for connector and tunnel-heavy service
- PostgreSQL
- S3-compatible storage
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

## 4. Local development modes

### Full Compose

Runs PostgreSQL, MinIO, gateway, server, MCP, browser worker and tunnel gateway.

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

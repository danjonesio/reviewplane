# Project Charter

## 1. Product name

ReviewPlane

Machine identifier: `reviewplane`

Marketing resides at `reviewplane.dev` and is not built in this repository. Protocol and database identifiers must not depend on the display name.

## 2. Mission

Build a private, self-hosted control plane that lets humans supervise AI coding agents in live browser sessions, create precise visual reviews, deliver those reviews to CLI agents through MCP, and require verifiable evidence before human acceptance.

## 3. Locked product loop

```text
Agent starts local application
  -> connector publishes it privately
  -> central browser worker opens it
  -> agent operates through MCP
  -> human watches or annotates
  -> human creates named review
  -> agent retrieves and resolves findings
  -> agent submits before/after evidence
  -> human accepts or reopens
```

Changes that remove any part of this loop from the product centre require an ADR and product review.

## 4. Locked architectural decisions

- Docker Compose is the first-class deployment.
- Chromium runs in central browser-worker containers.
- Development VMs run a native outbound connector.
- Local dev servers are reached through scoped reverse tunnels.
- MCP is the initial agent interface.
- Reviews are durable domain objects and the system of record.
- Human-authored findings require human acceptance.
- PostgreSQL stores authoritative metadata.
- S3-compatible storage contains large artefacts.
- Live frames are ephemeral by default.
- Original screenshots and annotations are stored separately.
- Browser input uses a single-controller lease and control epoch.
- Browser content is treated as untrusted.
- The control-plane server does not receive Docker-socket access.
- Kubernetes and full desktop streaming are deferred.

See the ADR index for rationale.

## 5. Initial technology direction

| Component | Direction |
|---|---|
| Monorepo | TypeScript workspace plus Go services |
| Web | Astro, React islands, Tailwind CSS |
| API/MCP/jobs | TypeScript on pinned LTS Node runtime |
| Browser | Playwright and Chromium |
| Connector/tunnel host code | Go |
| Database | PostgreSQL |
| Artefacts | S3-compatible storage, MinIO bundled |
| Realtime | WebSockets |
| Packaging | OCI images and Docker Compose |
| Schemas | Versioned shared schemas with generated TypeScript and Go types |

A specific framework replacement or new required infrastructure dependency needs an ADR.

## 6. First customer

Technical individual developers and small teams running coding agents in remote development environments, particularly self-hosted VMs and homelabs.

## 7. First killer capability

> Annotate a live application, assign the named visual review to a CLI coding agent, and receive verified before-and-after evidence.

Live viewing is important but supports this workflow rather than replacing it.

## 8. MVP definition

The Stage 1 MVP is complete only when a user can:

1. Deploy the stack with Docker Compose.
2. Enrol a connector on a remote development VM.
3. Publish a loopback development service.
4. Start a central Chromium session.
5. View the live browser.
6. Draw annotations and create a named review.
7. Retrieve the review in a CLI agent through MCP.
8. Resolve findings and attach verification evidence.
9. Accept or reopen each finding in the web app.
10. Back up and restore the installation.

## 9. Quality bar

- No cross-project access
- No concurrent agent and human browser input
- No claim of completion without configured evidence
- No public development VM port required
- No raw secret returned through MCP
- Connector and browser failures are diagnosable
- Core workflow covered by automated end-to-end test
- Documentation updated with behaviour

## 10. Product constraints

- Must work without a vendor cloud account
- Must support customer-owned storage
- Must avoid mandatory external telemetry
- Must remain useful with more than one coding-agent product
- Must have a credible air-gapped path
- Must not require Kubernetes for ordinary installations

## 11. Non-goals for the initial project

- General remote desktop
- Full agent orchestration
- Cloud IDE
- Built-in Git hosting
- Model hosting
- CI/CD replacement
- Generic bug tracker
- Native desktop applications
- Arbitrary remote shell
- Browser support beyond Chromium

## 12. Decision process

For product or architecture changes:

1. State the user problem.
2. Identify affected principles and trust boundaries.
3. Propose alternatives.
4. Record the decision as an ADR.
5. Update normative documents.
6. Add migration and test requirements.

## 13. Definition of done for implementation changes

A change is done when:

- User-visible behaviour is complete
- Domain invariants are maintained
- Security checks are enforced server side
- Protocol schemas are versioned
- Unit, integration and relevant end-to-end tests pass
- Failure modes are observable
- Documentation is current
- Browser-facing work has visual evidence

## 14. Repository document ownership

| Document | Purpose |
|---|---|
| `PROJECT.md` | Locked execution charter |
| `PRODUCT.md` | User problem, proposition and scope |
| `DESIGN_PRINCIPLES.md` | Normative decision principles |
| `DOMAIN_MODEL.md` | Entities and lifecycles |
| `ARCHITECTURE.md` | Components, data and network topology |
| `SECURITY.md` | Trust, threats and security controls |
| `MCP_SPEC.md` | Agent-facing tools and resources |
| `CONNECTOR_PROTOCOL.md` | Development-environment protocol |
| `EVENTS.md` | Event contracts |
| `API.md` | Human-facing API and realtime channels |
| `UX_FLOWS.md` | Interaction design |
| `ROADMAP.md` | Delivery stages and exit criteria |
| `DEPLOYMENT.md` | Self-hosting model |
| `OPERATIONS.md` | Runtime operation |
| `TESTING.md` | Quality and release gates |
| `DEVELOPMENT.md` | Local engineering workflow |
| `adr/` | Settled decisions and rationale |

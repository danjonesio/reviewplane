# Architecture

## 1. Scope

This document defines the target architecture for the initial product and its planned scaling path. It prioritises a reliable single-host Docker Compose deployment while preserving clean boundaries for dedicated browser workers and later orchestration.

## 2. Architectural summary

- The control plane is authoritative for projects, reviews, policies, sessions and events.
- Chromium runs in separate browser-worker containers.
- Development applications remain in development environments.
- A native connector establishes outbound authenticated tunnels.
- Agents use MCP to operate browsers and retrieve reviews.
- Humans use the web UI and WebSockets for live supervision and control.
- PostgreSQL stores authoritative metadata.
- A pluggable artefact store holds large artefacts: filesystem driver by default, S3-compatible driver optional.
- Docker Compose is the first-class deployment.

## 3. System context

```mermaid
flowchart TB
    Human[Human browser] -->|HTTPS/WSS| Gateway
    Agent[CLI coding agent] -->|MCP through local bridge or HTTPS| Gateway
    Connector[Development connector] -->|Outbound mTLS/WSS| Gateway
    Gateway --> Control[Control-plane server]
    Gateway --> MCP[MCP server]
    Gateway --> Tunnel[Tunnel gateway]
    Control --> Postgres[(PostgreSQL)]
    Control --> Objects[(Artefact store)]
    MCP --> Control
    Control --> Worker[Background worker]
    Control --> Browser[Browser worker]
    Browser -->|Scoped private route| Tunnel
    Tunnel --> Connector
    Connector --> DevServer[Local development server]
    Browser -->|Artefact upload| Control
```

## 4. Deployment units

### 4.1 Gateway

Responsibilities:

- TLS termination or integration with an external reverse proxy
- Host and path routing
- WebSocket upgrades
- Request-size and connection limits
- Security headers
- Web-application static asset serving

A bundled Caddy configuration is the preferred default. Bring-your-own reverse proxy remains supported.

### 4.2 Server

One codebase may initially run multiple process roles:

- `api`: HTTP API, authentication and domain logic
- `jobs`: durable background work
- `realtime`: session event fan-out if separated later

Responsibilities:

- Projects, reviews, findings and policies
- Browser orchestration
- Authorisation
- Control leases
- Artefact metadata
- Audit and domain event creation
- Human UI backend

### 4.3 Web application

Preferred initial stack (ADR-0011):

- Vite-built React single-page application
- TanStack Router for type-safe routing
- TanStack Query for server state
- Tailwind CSS
- TypeScript

The build output is static assets served by the gateway; the web application has no server-side rendering process. All surfaces, including the live session room and annotation canvas, are client-rendered React using the HTTP API and WebSocket channels.

### 4.4 MCP server

Responsibilities:

- Expose agent tools and resources
- Authenticate agent sessions
- Scope calls to project and capability
- Translate MCP operations into domain commands
- Return structured, bounded context
- Label browser-derived content as untrusted

It may share packages and deployment image with the server but should be a separate process and route.

### 4.5 Browser worker

Responsibilities:

- Run Chromium and Playwright
- Create isolated browser contexts
- Navigate and interact
- Produce accessibility and DOM snapshots
- Capture screenshots, traces, console and network evidence
- Stream ephemeral live frames
- Apply redaction before persistence
- Enforce session limits

Browser workers are semi-trusted execution components because they process untrusted application content.

### 4.6 Tunnel gateway

Responsibilities:

- Terminate connector data channels
- Authenticate connector identity
- Register published local services
- Route browser requests using session-scoped capabilities
- Apply destination restrictions and expiry
- Record bytes, errors and route lifecycle

It must not become an unrestricted SOCKS or general network proxy. It therefore exposes no CONNECT method, refuses an absolute-form request target, and has no code path that takes an upstream destination from a request: the destination comes from the route registry alone.

It serves three listeners, and the separation is a control rather than a convenience: the browser-facing listener is the only one a deployment publishes, the connector listener terminates mutually authenticated data channels, and the control listener carrying the route-registration API and metrics binds to loopback by default.

Connector identity is derived from the verified client-certificate chain issued by the control plane's certificate authority; the gateway holds only the authority's root and never issues. Where in the certificate the identifier is read from is configuration, so that the issuing side can change without a gateway release.

The gateway holds no database connection. Route registrations arrive from the control plane, and route lifecycle is emitted as structured audit records; the durable event rows of §10 belong to the control plane, which owns the project event sequence.

### 4.7 Connector

Preferred implementation: Go static binary.

Responsibilities:

- Enrol and maintain device identity
- Detect configured workspaces and Git state
- Publish explicitly authorised local ports
- Establish outbound tunnels
- Associate agent sessions where supported
- Report health and capabilities
- Display local notifications

The connector must not upload repository contents by default.

### 4.8 Background worker

Responsibilities:

- Thumbnail generation
- Retention enforcement
- Export generation
- Artefact integrity checks
- Staleness analysis
- Notification fan-out
- Cleanup of abandoned sessions and routes

Initial durable jobs may use PostgreSQL row locking. A separate message broker is deferred until measured load requires it.

## 5. Data architecture

### 5.1 PostgreSQL

Authoritative data:

- Organisations and users
- Projects and environments
- Connectors and workspaces
- Agent and browser sessions
- Reviews, findings, comments and verification
- Control leases
- Policies and approval records
- Artefact metadata
- Domain and audit events
- Durable jobs

Use transactions to maintain domain invariants. Multi-step commands must produce state and event records atomically where practical.

### 5.2 Artefact store

Artefact storage is accessed only through an internal storage-driver interface (ADR-0012). The `filesystem` driver is the default and writes to a single data-directory volume; the `s3` driver targets any S3-compatible endpoint for customer-owned or external storage. Browser workers upload artefacts through the control-plane artefact API and hold no storage credentials.

Stores:

- Original screenshots
- Derived thumbnails
- Traces
- HAR and logs
- DOM and accessibility snapshots when too large for PostgreSQL
- Video when enabled
- Review exports

Artefact keys are content-addressed and must not expose user-entered names. Where the `s3` driver issues presigned URLs, they must be short-lived and scoped; the `filesystem` driver serves artefacts through the server with equivalent short-lived, scoped access tokens.

### 5.3 Ephemeral data

- Live browser frames
- Browser process temporary directories
- Short-lived command acknowledgements
- In-flight tunnel buffers

Ephemeral data must not be persisted unless a configured recording policy converts it into an artefact.

## 6. Browser topology

### 6.1 Central workers

The initial architecture uses centrally managed browser workers rather than Chromium installed in each development VM.

Benefits:

- Consistent browser and Playwright versions
- Central live viewing
- Easier isolation and resource management
- Simpler updates
- Agent-independent access
- Central evidence capture

### 6.2 Worker isolation

Initial isolation:

- Dedicated non-root container user
- Read-only base filesystem where practical
- Per-session temporary directory
- Playwright browser context isolation
- Resource limits
- No host Docker socket
- No access to control-plane secrets
- Explicit network routes only

A browser session is allocated as a Playwright persistent context over its own ephemeral profile directory, which gives it its own browser process as well as its own context. That is one step short of the container-per-session option below and satisfies both the per-session temporary directory and the context-isolation requirements with one mechanism. Termination closes the browser and removes the directory.

"Explicit network routes only" is enforced by the worker: navigation and subresource requests are restricted to the origin of the session's published service, so a session with no published service reaches nothing. `docs/SECURITY.md` section 10.1 records the container controls that carry the rest.

Higher-assurance deployments may allocate one container or microVM per browser session later.

### 6.3 Live viewing

Use CDP screencast frames or equivalent browser-worker capture:

- Fleet thumbnails: approximately 2 to 5 frames per second
- Open session room: adaptive 10 to 20 frames per second
- Human takeover: increased rate as resources allow
- Frame quality and dimensions adapt to bandwidth
- Frames are dropped rather than queued when viewers fall behind

Live frames are ephemeral and delivered over authenticated WebSockets.

### 6.4 Human input

Human keyboard and pointer input is sent through the control plane to the worker. Every command includes:

- Browser session ID
- Controller identity
- Control epoch
- Sequence number
- Timestamp

Stale epochs are rejected.

These five fields are the envelope of every browser command, not only of human input: they are declared once in `packages/protocol/schemas/browser/v1.schema.json` and required by the generated validators on both sides, so a command cannot omit one. The control plane checks them before dispatch and the worker checks them again before touching a page. An epoch that is not the current one is rejected whether it is older or newer, and a sequence number that is not greater than the last accepted one is rejected as a replay. Non-interactive system capture is authorised without the interactive lease and never transfers it.

## 7. Development-service routing

### 7.1 Problem

A central browser cannot reach `localhost` on a remote development VM directly.

### 7.2 Solution

The connector publishes a local service through an outbound tunnel.

```mermaid
flowchart LR
    Browser[Browser context] -->|HTTP request with route capability| TG[Tunnel gateway]
    TG -->|Multiplexed encrypted stream| C[Connector]
    C -->|Loopback TCP| App[127.0.0.1:4321]
```

### 7.3 Route properties

- Project scoped
- Browser-session scoped
- Short-lived
- Host and port restricted
- Protocol declared
- Audited
- Revocable immediately

The browser receives an internal origin:

```text
https://public-alias.internal.invalid/
```

The leftmost label is the published service's `public_alias` (`DOMAIN_MODEL.md` §10), not its identifier: a conventional `svc_` identifier is not a valid DNS label. The alias MUST be a DNS label and MUST be unique across the deployment, and it is validated at registration rather than normalised at request time, so the mapping from origin to route is total and injective.

The gateway resolves an origin by dropping any port, dropping a trailing dot and lowercasing; what remains MUST be exactly one label followed by the configured suffix. Anything else resolves to no route. Host and origin handling MUST be deterministic and documented; the forwarding rules are in `CONNECTOR_PROTOCOL.md` §13.

### 7.5 What the publication path does today

The publication half of §7.2 is implemented and is exercised end to end against the real connector binary by `apps/server/test/route-publication.test.ts`:

1. `POST /api/v1/projects/:projectId/published-services` validates the destination against the control plane's own policy before any row exists (`SECURITY.md` §9), writes the record as `requested` and records `published_service.requested`.
2. The control plane sends `route.publish` down the control channel the connector already holds open, and waits, bounded, for the acknowledgement (`CONNECTOR_PROTOCOL.md` §11). No channel is `CONNECTOR_OFFLINE`; no answer is `CONTROL_PLANE_UNAVAILABLE`.
3. The connector validates independently against its own configuration, probes the destination within a bounded startup grace, and answers `ready` with the destination it observed or `rejected` with a stable class.
4. Only then is the route registered with the tunnel gateway, the record becomes `ready`, and `published_service.ready` is recorded. A refusal at any step leaves the record `failed` carrying the class, never free text.

The connector opens no listening socket at any point, which the same test asserts with `ss -ltnp` while a route is being carried.

Capabilities are minted by the control plane and verified by the gateway. A capability is opaque to its bearer, binds route, project and browser session, expires, and is revocable individually as well as through its route.

The browser worker receives its session's capability in the allocation message and presents it as `X-ReviewPlane-Capability` on every request to the session's origin, and on no other request. The gateway strips the whole `X-ReviewPlane-` namespace before forwarding, so the credential never reaches the development service. How Chromium resolves an internal origin and trusts the gateway's certificate is ADR-0015.

### 7.4 Application compatibility

The tunnel must support:

- HTTP/1.1
- WebSockets
- HTTP streaming
- Server-sent events
- Development hot reload
- Configurable upstream TLS

HTTP/2 and additional protocols may be added later.

## 8. Agent integration

### 8.1 MCP

MCP is the initial agent-facing interface.

Supported connection forms:

- Local stdio bridge installed with the connector
- Remote authenticated HTTP endpoint

The local bridge is preferred where the CLI client handles local MCP configuration more reliably. It authenticates to the control plane using scoped device or session credentials.

### 8.2 Agent knowledge

Agents learn when to use the product through:

1. Repository instructions in `AGENTS.md` and client-specific files
2. MCP tool descriptions
3. Project policies and completion gates
4. Inbox checks at safe workflow boundaries

Tool descriptions assist selection. Policy and completion gates enforce required evidence.

### 8.3 Capability negotiation

Agent sessions advertise capabilities such as:

```json
{
  "mcp_tools": true,
  "mcp_resources": true,
  "image_resources": true,
  "managed_messages": false,
  "session_resume": true
}
```

The control plane must degrade clearly when a client cannot consume image resources or managed notifications.

## 9. Review architecture

The review service owns:

- Review lifecycle
- Finding lifecycle
- Annotation storage
- Assignment
- Staleness calculation
- Verification submission
- Human acceptance

Review commands are idempotent where network retries are likely. Human and agent actions produce immutable events.

## 10. Event architecture

The system uses an append-only event table for:

- Audit
- Session timeline
- Integration delivery
- Operational diagnosis

Current state remains in normalised tables. Events do not require full event sourcing of all aggregates.

Real-time updates:

1. Command commits state and event in PostgreSQL
2. A notifier publishes committed event IDs
3. Realtime process fetches and broadcasts authorised payloads
4. Clients resume using last seen sequence

A PostgreSQL notification mechanism is acceptable initially. Later brokers must preserve event ordering semantics.

## 11. Authentication and authorisation

### Human

Initial:

- Local accounts
- Secure session cookies
- Optional bootstrap administrator token

Later:

- OIDC
- SAML through enterprise integration
- MFA policy through identity provider

### Connector

- One-time enrolment token
- Device key pair generated locally
- Issued client certificate or equivalent signed identity
- mTLS or cryptographically bound channel
- Revocation support

The mechanism is ADR-0014: a control-plane certificate authority, generated at bootstrap and persisted server-side, issues one X.509 client certificate per connector. Its private key never leaves the control plane; the CA certificate is exported so that the tunnel gateway can verify the same identities. Stage 0 terminates the connector channels on a dedicated mutually authenticated listener rather than behind the shared gateway of §4.1, because the human API does not request client certificates.

### Agent

- Agent session token bound to connector, project and capabilities
- Short lifetime
- Not reusable as a human token

### Browser worker

- Worker identity and mutual authentication
- Commands signed or sent over mutually authenticated internal channels
- Worker restricted to assigned projects and sessions

Stage 0 implements the mutual authentication as two distinct credentials on an internal network, one per direction: the worker presents its own credential to the control-plane API, and the control plane presents a different credential to the worker's listener. Neither is an administrator token, neither works in the other direction, and neither is accepted on an administrative endpoint. A worker may only receive sessions for projects an administrator has assigned to it; an unassigned worker serves nothing. Mutual TLS replaces the shared credentials when remote worker nodes arrive in Stage 3.

## 12. Technology baseline

Initial preferred technologies:

| Area | Choice |
|---|---|
| Monorepo | pnpm workspaces with task runner as needed |
| Web | Vite React SPA, TanStack Router/Query, Tailwind CSS, TypeScript |
| Server | TypeScript on current pinned LTS Node runtime |
| HTTP | Fastify or equivalent schema-first framework |
| Browser | Playwright with Chromium |
| Connector | Go |
| Database | PostgreSQL |
| Artefact store | Filesystem driver default; S3-compatible driver optional |
| Realtime | WebSockets |
| Deployment | OCI containers and Docker Compose |
| Schemas | JSON Schema 2020-12 in `packages/protocol`, with generated TypeScript and Go models (ADR-0013) |

Specific libraries require ADR when they shape public interfaces or operational dependencies.

## 13. Scaling path

### Stage 1

Single host:

- One server deployment
- One MCP process
- One job worker
- One browser worker
- Bundled PostgreSQL and filesystem artefact storage

### Stage 2

Production Compose:

- External PostgreSQL and S3-compatible artefact storage optional
- Multiple browser-worker processes on one host
- Separate realtime and job processes

### Stage 3

Remote worker nodes:

- Browser workers register outbound
- Control plane schedules based on capacity and labels
- Workers use short-lived session credentials

### Stage 4

Kubernetes:

- Stateless API, MCP and workers as Deployments
- Browser workers scheduled with dedicated resource limits
- External or operator-managed PostgreSQL and S3-compatible artefact storage
- Helm chart

Kubernetes is not an MVP requirement.

## 14. Failure handling

### Connector disconnect

- Mark routes unavailable
- Pause affected browser actions
- Retain review and session metadata
- Attempt bounded reconnect
- Do not redirect traffic to a different environment silently

### Browser worker crash

- Mark session degraded or failed
- Preserve uploaded evidence
- Revoke control lease
- Offer fresh session allocation
- Restore storage state only when explicitly configured

### Control-plane restart

- Recover durable jobs
- Expire stale leases
- Resume event delivery from sequence
- Reconcile workers and connectors

### Artefact upload failure

- Keep finding verification incomplete
- Retry with content hash and idempotency key
- Never record an artefact as available before integrity verification

### Database unavailable

- Reject state-changing actions safely
- Browser workers may terminate or pause after a bounded grace period
- Do not continue unaudited destructive operations

## 15. Observability

Every service emits:

- Structured logs
- Metrics
- Trace correlation identifiers
- Version and capability information
- Health and readiness endpoints

Sensitive values must not appear in logs.

Core correlation IDs:

- Request ID
- Event ID
- Project ID
- Agent session ID
- Browser session ID
- Review ID
- Finding ID
- Connector ID

## 16. Deferred architecture

Not in the initial architecture:

- Full desktop VNC streaming
- Multi-browser support
- Generic internet proxying
- Direct terminal prompt injection
- Built-in LLM hosting
- General multi-agent scheduler
- Full event-sourced state reconstruction
- Service mesh
- Mandatory distributed broker
- Kubernetes-only deployment

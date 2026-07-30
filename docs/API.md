# HTTP and Realtime API

## 1. Purpose

This document defines the human-facing and integration API shape. It is separate from MCP because human clients, administration, browser live viewing and external integrations have different authentication and response needs.

## 2. API principles

- JSON over HTTPS for control and metadata
- WebSockets for realtime events, live frames and human control
- Explicit API versioning
- Cursor pagination
- Idempotency for retried writes
- Optimistic concurrency for collaborative records
- Stable machine-readable error codes
- No direct object-storage credentials exposed to untrusted clients

## 3. Base paths

```text
/api/v1/...
/ws/v1/...
/mcp/...          separate agent endpoint
```

## 4. Authentication

Human API:

- Secure session cookie for web UI
- CSRF token for state-changing browser requests
- API tokens later for integrations

Connector, worker and agent authentication use separate endpoints and credentials.

## 5. Common metadata

Responses include:

```json
{
  "data": {},
  "meta": {
    "request_id": "req_..."
  }
}
```

Errors:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "The finding changed since it was loaded.",
    "details": {
      "current_version": 8
    }
  },
  "meta": {
    "request_id": "req_..."
  }
}
```

## 6. Pagination

Cursor format is opaque.

```text
GET /api/v1/projects/prj_.../reviews?limit=50&cursor=...
```

Response:

```json
{
  "data": [],
  "meta": {
    "next_cursor": "...",
    "request_id": "req_..."
  }
}
```

## 7. Organisation endpoints

```text
GET    /api/v1/organisation
PATCH  /api/v1/organisation
GET    /api/v1/members
POST   /api/v1/members/invitations
PATCH  /api/v1/members/:membershipId
DELETE /api/v1/members/:membershipId
```

Team endpoints may be staged after the single-user release, but route structure should remain reserved.

## 8. Project endpoints

```text
GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/:projectId
PATCH  /api/v1/projects/:projectId
DELETE /api/v1/projects/:projectId
GET    /api/v1/projects/:projectId/activity
```

Project deletion should initially archive and require a separate destructive purge flow.

## 9. Environment and connector endpoints

```text
GET    /api/v1/projects/:projectId/environments
GET    /api/v1/environments/:environmentId
POST   /api/v1/connectors/enrolment-tokens
GET    /api/v1/connectors/certificate-authority
GET    /api/v1/connectors
GET    /api/v1/connectors/:connectorId
POST   /api/v1/connectors/:connectorId/revoke
```

### Enrolment-token issuance

`POST /api/v1/connectors/enrolment-tokens` creates the one-time token of `CONNECTOR_PROTOCOL.md` §4.1.

```json
{
  "project_id": "prj_...",
  "expires_in_seconds": 3600,
  "max_uses": 1,
  "environment_labels": ["proxmox", "development"]
}
```

Every field is optional. `max_uses` defaults to 1. `environment_labels` pins the labels the enrolling environment must declare; an environment that does not carry all of them is refused with `ENROLMENT_TOKEN_INVALID`.

The response is the only place the token value appears; the control plane stores its hash and cannot reproduce it.

```json
{
  "data": {
    "id": "ent_...",
    "organisation_id": "org_...",
    "project_id": null,
    "environment_labels": [],
    "max_uses": 1,
    "expires_at": "2026-07-28T12:00:00.000Z",
    "enrolment_token": "shown once",
    "enrolment_endpoint": "wss://agents.example.internal/connector/v1/enrol"
  },
  "meta": { "request_id": "req_..." }
}
```

### Certificate-authority export

`GET /api/v1/connectors/certificate-authority` returns the connector certificate authority's certificate, which a tunnel gateway needs as its trust anchor to verify the same connector identities (ADR-0014). The CA private key is not part of this or any other response.

```json
{
  "data": {
    "certificate_pem": "-----BEGIN CERTIFICATE-----\n...",
    "fingerprint": "sha256:...",
    "subject": "CN=ReviewPlane connector CA, O=ReviewPlane",
    "not_after": "2036-07-28T00:00:00.000Z"
  },
  "meta": { "request_id": "req_..." }
}
```

### Stage 0 authentication on this surface

Human authentication is not yet built, so these endpoints require the bootstrap administrator token of `ARCHITECTURE.md` §11 as `Authorization: Bearer <token>`, compared in constant time and never logged. A connector credential — its identity, certificate, fingerprint or enrolment token — MUST NOT be accepted here (`TESTING.md` §10). Local accounts and sessions replace the bootstrap token when they land.

## 10. Published-service endpoints

```text
GET    /api/v1/projects/:projectId/published-services
POST   /api/v1/projects/:projectId/published-services
DELETE /api/v1/published-services/:serviceId
POST   /api/v1/published-services/:serviceId/capabilities
```

Creation requires connector, workspace, local destination and TTL. The local destination MUST satisfy the destination policy of `SECURITY.md` §9 before any record is written, so a refused destination never produces a published-service row or an event. The requested TTL MUST NOT exceed the configured maximum route lifetime.

The response carries the published-service record of `DOMAIN_MODEL.md` §10 plus `internal_origin`, the origin a browser worker uses. `public_alias` is generated by the control plane and MUST be a DNS label; it is never the `serviceId`, because a conventional `svc_` identifier is not a valid label.

A route becomes `ready` only after the tunnel gateway has accepted it. If the gateway refuses, the record becomes `failed` carrying the gateway's stable error class from `CONNECTOR_PROTOCOL.md` §21, and the response reports that class.

Deletion revokes immediately: the gateway is instructed before the record changes, so the control plane never reports a route closed while the tunnel still carries it. Deletion is idempotent and produces at most one `published_service.revoked` event.

### Minting a session-scoped capability

A browser session cannot use a published route without a capability, and the control plane is the minting authority (`ARCHITECTURE.md` §7.3). The gateway verifies; it never mints.

```json
{
  "browser_session_id": "brs_...",
  "ttl_seconds": 300
}
```

Response:

```json
{
  "data": {
    "capability_id": "cap_...",
    "capability": "rp1....",
    "browser_session_id": "brs_...",
    "internal_origin": "https://alias.internal.invalid/",
    "expires_at": "2026-07-30T12:05:00Z"
  },
  "meta": { "request_id": "req_..." }
}
```

Requirements:

- The browser session MUST be named in the route's `allowed_browser_session_ids`; otherwise the request is denied with `AUTHORISATION_DENIED`.
- The capability MUST NOT outlive its route: `expires_at` is the earlier of the requested lifetime and the route's expiry.
- The token is returned once and MUST NOT be persisted by the control plane. Its identifier is persisted, so a single capability can be revoked and audited without storing the credential.
- The token value MUST NOT appear in any event payload, audit record or log line (`SECURITY.md` §18).

### Additional stable error code

`VALIDATION_FAILED` joins the codes of `MCP_SPEC.md` §12 for a request whose body does not satisfy its schema. Failures that originate in the tunnel keep their `CONNECTOR_PROTOCOL.md` §21 class (`DESTINATION_NOT_ALLOWED`, `ROUTE_EXPIRED`, `ROUTE_LIMIT_EXCEEDED`), so one failure has one code from the connector to the caller.

## 11. Browser-session endpoints

```text
GET    /api/v1/projects/:projectId/browser-sessions
POST   /api/v1/projects/:projectId/browser-sessions
GET    /api/v1/browser-sessions/:sessionId
POST   /api/v1/browser-sessions/:sessionId/allocate
POST   /api/v1/browser-sessions/:sessionId/commands
POST   /api/v1/browser-sessions/:sessionId/pause
POST   /api/v1/browser-sessions/:sessionId/resume
POST   /api/v1/browser-sessions/:sessionId/terminate
POST   /api/v1/browser-sessions/:sessionId/control/request
POST   /api/v1/browser-sessions/:sessionId/control/release
GET    /api/v1/browser-sessions/:sessionId/timeline
```

Worker administration:

```text
GET    /api/v1/browser-workers
PUT    /api/v1/browser-workers/:workerId/assignments
```

A worker serves only the projects an assignment names. There is no wildcard: an unassigned worker receives no sessions.

### Command request

```json
{
  "control_epoch": 12,
  "controller": {"type": "agent", "id": "ags_..."},
  "command": {
    "command": "navigate",
    "timeout_ms": 30000,
    "navigate": {"url": "/checkout", "wait_until": "domcontentloaded"}
  }
}
```

The command body is the `browser_command` of `packages/protocol/schemas/browser/v1.schema.json`. A stale `control_epoch` returns `CONTROL_EPOCH_STALE` with the epoch that is current, and the command never reaches the worker. Responses carry the `browser_command_result`, whose `trust` and `instruction_policy` fields the schema requires on every result.

### Start request

```json
{
  "organisation_id": "org_...",
  "published_service_id": "svc_...",
  "viewport": {
    "width": 1440,
    "height": 900,
    "device_scale_factor": 1
  },
  "trace_enabled": true,
  "video_enabled": false
}
```

`organisation_id` and `viewport` are required. `published_service_id` names the route the session may reach; the control plane resolves the origin from that record and mints the session-scoped capability itself. Neither the origin nor the capability is accepted from the caller: the origin *is* the worker's egress allow-list (`SECURITY.md` §9) and the capability is a bearer credential the control plane alone mints (`ARCHITECTURE.md` §7.3).

### Reserving a session before publishing a route

Publication and allocation each need the other to have gone first. `POST /api/v1/projects/:projectId/published-services` requires the browser sessions a route authorises, and `CONNECTOR_PROTOCOL.md` §11 forbids publishing a route no session may use; meanwhile a worker's egress policy is fixed when its browser context is created and MUST NOT be widened afterwards.

A start request MAY therefore set `"allocate": false`, which reserves the session and stops:

```json
{
  "organisation_id": "org_...",
  "viewport": {"width": 1440, "height": 900, "device_scale_factor": 1},
  "allocate": false
}
```

The response is a `REQUESTED` session (`DOMAIN_MODEL.md` §12) with an identifier and a chosen worker, and no worker has been contacted. That identifier can then appear in the route's `allowed_browser_session_ids`, after which the session is allocated:

```text
POST /api/v1/browser-sessions/:sessionId/allocate
```

```json
{ "published_service_id": "svc_..." }
```

Allocation contacts the worker, binds the origin and the freshly minted capability, and moves the session `REQUESTED` → `ALLOCATING` → `READY`. Only a `REQUESTED` session may be allocated; anything else is `BROWSER_SESSION_NOT_ACTIVE`. A published service belonging to another project is refused with `PROJECT_CONTEXT_MISMATCH`, and a session the route does not name is refused with `AUTHORISATION_DENIED` before any capability is minted.

The one-request form remains available for a session that needs no route, or whose route already names it: omit `allocate` and the control plane reserves and allocates in one call.

## 12. Review endpoints

```text
GET    /api/v1/projects/:projectId/reviews
POST   /api/v1/projects/:projectId/reviews
GET    /api/v1/reviews/:reviewId
PATCH  /api/v1/reviews/:reviewId
POST   /api/v1/reviews/:reviewId/assign
POST   /api/v1/reviews/:reviewId/request-review
POST   /api/v1/reviews/:reviewId/accept
POST   /api/v1/reviews/:reviewId/reopen
POST   /api/v1/reviews/:reviewId/archive
GET    /api/v1/reviews/:reviewId/export
```

Review accept checks that all required human-authored findings are resolved or explicitly waived.

## 13. Finding endpoints

```text
GET    /api/v1/reviews/:reviewId/findings
POST   /api/v1/reviews/:reviewId/findings
GET    /api/v1/findings/:findingId
PATCH  /api/v1/findings/:findingId
POST   /api/v1/findings/:findingId/claim
POST   /api/v1/findings/:findingId/comments
POST   /api/v1/findings/:findingId/verifications
POST   /api/v1/findings/:findingId/accept
POST   /api/v1/findings/:findingId/reopen
POST   /api/v1/findings/:findingId/wont-fix
```

Updates include `expected_version`.

## 14. Annotation endpoints

```text
POST   /api/v1/findings/:findingId/annotations
PATCH  /api/v1/annotations/:annotationId
DELETE /api/v1/annotations/:annotationId
```

Annotation changes preserve revision history even if the current projection hides deleted revisions.

## 15. Artefact endpoints

```text
POST   /api/v1/projects/:projectId/artefacts/uploads
POST   /api/v1/artefacts/:artefactId/content
POST   /api/v1/artefacts/:artefactId/complete
GET    /api/v1/artefacts/:artefactId
GET    /api/v1/artefacts/:artefactId/content
DELETE /api/v1/artefacts/:artefactId
```

### Upload flow

1. Create upload intent with kind, size and hash.
2. Receive short-lived upload URL or proxied upload endpoint.
3. Upload content.
4. Complete with observed hash.
5. Server verifies before making artefact available.

Under the `filesystem` driver step 2 returns `upload_path`, the proxied endpoint above; the `s3` driver may return a presigned URL instead. Step 5 is the whole point of the flow: the server recomputes the digest of the bytes it stored and compares it with both the declared and the observed value. Until that succeeds the artefact stays `pending` or `uploaded`, `GET .../content` refuses with `ARTEFACT_UPLOAD_INCOMPLETE`, and no caller may treat it as evidence. A mismatch marks the artefact `failed` and records `artefact.upload_failed`.

## 15.1 Internal worker channel

Browser workers use a separate base path and a separate credential (`docs/ARCHITECTURE.md` section 11). These routes are not part of the human or integration API and are never reachable with an administrator token alone.

```text
POST /internal/v1/workers/register
POST /internal/v1/workers/heartbeat
POST /internal/v1/browser-sessions/:sessionId/status
```

Bodies are browser-protocol frames rather than ad-hoc JSON, so the envelope and payload are validated by the generated validator before any domain code runs. In the other direction the control plane calls the worker's own listener with a second, distinct credential.

## 16. Inbox endpoints

```text
GET  /api/v1/projects/:projectId/inbox
POST /api/v1/inbox/:itemId/acknowledge
POST /api/v1/inbox/:itemId/complete
POST /api/v1/inbox/:itemId/dismiss
```

## 17. Policy and approval endpoints

```text
GET    /api/v1/projects/:projectId/policies
POST   /api/v1/projects/:projectId/policies
PATCH  /api/v1/policies/:policyId
GET    /api/v1/projects/:projectId/approvals
POST   /api/v1/approvals/:approvalId/grant
POST   /api/v1/approvals/:approvalId/reject
```

## 18. WebSocket channels

### 18.1 Project events

```text
/ws/v1/projects/:projectId/events
```

Client sends last sequence. Server emits event envelopes from `EVENTS.md`.

### 18.2 Browser live stream

```text
/ws/v1/browser-sessions/:sessionId/live
```

Subprotocol separates:

- Frame metadata
- Binary frame payload
- Cursor and target overlays
- Quality adaptation
- Heartbeats

The viewer can request quality but the worker scheduler remains authoritative.

### 18.3 Human control

```text
/ws/v1/browser-sessions/:sessionId/control
```

Messages include epoch and client sequence.

Example pointer input:

```json
{
  "type": "pointer",
  "epoch": 28,
  "sequence": 181,
  "action": "move",
  "x_normalised": 0.52,
  "y_normalised": 0.18,
  "buttons": 0
}
```

Keyboard messages must support composition and key-up/key-down semantics.

## 19. Rate and size limits

Apply separate limits for:

- Authentication
- Metadata API
- Annotation writes
- Artefact upload
- Live viewers
- Control input
- Event replay

Limit errors return retry hints when appropriate.

## 20. Compatibility

- Additive fields are allowed within a major version.
- Clients must ignore unknown fields.
- Removing or changing meaning requires a new major path or compatibility adapter.
- WebSocket message schemas are versioned independently inside the path version.

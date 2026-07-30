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

### 4.1 Viewer sessions

Stage 0 implements the session cookie above through the exchange of ADR-0016:

```text
POST   /api/v1/auth/viewer-sessions
GET    /api/v1/auth/viewer-sessions/current
DELETE /api/v1/auth/viewer-sessions/current
POST   /api/v1/projects/:projectId/viewer-sessions
```

`POST /api/v1/auth/viewer-sessions` takes the bootstrap administrator token in
an `Authorization` header — never in a cookie, never in a URL — and answers
with `Set-Cookie: reviewplane_viewer=...; HttpOnly; SameSite=Strict; Secure`.
The control plane stores only the SHA-256 digest of the session token.

A viewer session carries an explicit project scope. The administrator's session
is organisation-wide; the project route mints one limited to a single project
and returns its token exactly once. Every read the web application performs is
filtered by that scope, and the live channel of section 18.2 authorises against
it before the WebSocket upgrade completes.

State-changing browser-session routes — start, command, terminate — remain
administrative and are not reachable with a viewer session.

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
GET    /api/v1/connectors
GET    /api/v1/connectors/:connectorId
POST   /api/v1/connectors/:connectorId/revoke
```

## 10. Published-service endpoints

```text
GET    /api/v1/projects/:projectId/published-services
POST   /api/v1/projects/:projectId/published-services
DELETE /api/v1/published-services/:serviceId
```

Creation requires connector, workspace, local destination and TTL.

## 11. Browser-session endpoints

```text
GET    /api/v1/projects/:projectId/browser-sessions
POST   /api/v1/projects/:projectId/browser-sessions
GET    /api/v1/browser-sessions/:sessionId
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
/ws/v1/browser-sessions/:sessionId/live?mode=session_room|thumbnail
```

Subprotocol separates:

- Frame metadata
- Binary frame payload
- Cursor and target overlays
- Quality adaptation
- Heartbeats

The viewer can request quality but the worker scheduler remains authoritative.

The messages are defined once, in
`packages/protocol/schemas/live_view/v1.schema.json` (ADR-0013), and are not
restated here:

| Message | Direction | Purpose |
|---|---|---|
| `live.attached` | control plane to viewer | Attachment accepted; states mode, format and that frame retention is `never` |
| `live.session_state` | control plane to viewer | Browser-session status, URL, viewport and control epoch |
| `live.frame` | worker to viewer | Metadata for the binary message that follows it |
| `live.quality` | worker to viewer | The rate, quality and dimensions the scheduler applied |
| `live.quality_request` | viewer to control plane | Advisory request, relayed to the worker |
| `live.heartbeat` | control plane to viewer | Sent, dropped, buffer depth and measured rate |
| `live.viewer_heartbeat` | viewer to control plane | Viewer liveness and the last sequence it painted |
| `live.error` | control plane to viewer | Stable error class plus the `docs/UX_FLOWS.md` section 18 state to display |

The separation is a transport rule, not a convention: a `live.frame` text
message is immediately followed by one binary message carrying the frame's
bytes, and `byte_length` in the metadata MUST equal the length of that message.
A receiver that reads a different length MUST discard the frame. A binary
message with no preceding metadata MUST be discarded rather than rendered.
Frame bytes MUST NOT be base64-encoded into a JSON message; the schema's
`additionalProperties: false` is what keeps that true over time.

Cursor and target overlays are reserved and are not sent in Stage 0.

Authentication and authorisation both complete before the upgrade
(section 4.1). An anonymous viewer, a viewer whose session is scoped to another
project, and a viewer whose browser session has ended are all refused with an
HTTP status on the handshake, so no WebSocket exists for them and no frame is
transmitted. The `Origin` header is checked against a configured allow list.

Internally the control plane obtains frames from the worker over a separate
leg, described in `docs/ARCHITECTURE.md` section 6.3. One worker stream serves
however many viewers are attached, and closing it is what stops capture.

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

### 19.1 Live-viewer limits implemented today

A live viewer is the cheapest way to make the control plane and a browser
worker do expensive work, so the bounds apply to an authorised viewer and not
only to an anonymous one (`docs/SECURITY.md` section 4).

| Limit | Value | Refusal |
|---|---|---|
| Concurrent viewers per browser session | 4 | `RATE_LIMITED` on the handshake |
| Concurrent viewers per viewer session | 8 | `RATE_LIMITED` on the handshake |
| Attach attempts per viewer session | 30 per minute | `RATE_LIMITED` on the handshake |
| Inbound messages per viewer | 20 per 10 seconds | `live.error` with `viewer_rate_limited`, then close |
| Inbound message size | 8192 bytes | Refused by the socket before buffering |
| Quality requests relayed to a worker | 1 per 2 seconds per session | Silently coalesced |

A refusal on the handshake carries `retry_after_ms` in its error details; a
refusal on an open socket carries it in the `live.error` payload.

A second viewer on a session costs the worker nothing: the control plane opens
one worker stream per browser session and fans it out.

## 20. Compatibility

- Additive fields are allowed within a major version.
- Clients must ignore unknown fields.
- Removing or changing meaning requires a new major path or compatibility adapter.
- WebSocket message schemas are versioned independently inside the path version.

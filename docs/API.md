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
/mcp/v1           separate agent endpoint, separate process (ADR-0020)
```

`/mcp/v1` is served by `apps/mcp-server` and reached through its own gateway
route. Nothing under `/api/v1` accepts an agent credential except
`GET /api/v1/artefact-content/:grantId`, and nothing under `/mcp` accepts a
human session.

## 4. Authentication

Human API:

- Secure session cookie for web UI
- CSRF token for state-changing browser requests
- API tokens later for integrations

Connector, worker and agent authentication use separate endpoints and credentials.

### 4.0 Local accounts

Stage 1 implements the human half of `docs/SECURITY.md` section 6.1: a local
account, established once from a one-time installation token, authenticating
with a password.

```text
GET    /api/v1/auth/bootstrap          is this installation still unclaimed?
POST   /api/v1/auth/bootstrap          consume the install token, set the account
POST   /api/v1/auth/sessions           sign in with email and password
GET    /api/v1/auth/sessions/current   the current session and its user
DELETE /api/v1/auth/sessions/current   sign out
DELETE /api/v1/auth/sessions           revoke every session this account holds
```

`GET /api/v1/auth/bootstrap` is unauthenticated by necessity — it is what the
first screen asks before anybody can sign in — and answers
`{"bootstrap_required": bool, "install_token_outstanding": bool,
"organisation": {…}}`. It MUST NOT disclose who the administrator is.

`POST /api/v1/auth/bootstrap` takes `token`, `email` and `password`. The token
is the one an operator minted with `reviewplane install-token`
(`docs/DEPLOYMENT.md` section 11). It is single-use and expiring: consumption
and the credential change commit in one transaction, so a token marked used
beside a password that was never set cannot occur. A token that is unknown,
expired or already consumed is answered `AUTHENTICATION_REQUIRED` with
`details.reason` of `install_token_invalid`, `install_token_expired` or
`install_token_consumed`.

`POST /api/v1/auth/sessions` takes `email` and `password` and answers `201` with
`{"session": …, "user": …}` plus two cookies:

```text
Set-Cookie: reviewplane_viewer=…; Path=/; HttpOnly; SameSite=Strict; Secure
Set-Cookie: reviewplane_csrf=…;   Path=/; SameSite=Strict; Secure
```

The session cookie is `HttpOnly` so no script can read it. The CSRF cookie is
deliberately readable, because the application has to echo it in the
`X-CSRF-Token` header; on its own it authenticates nothing. The control plane
stores only the SHA-256 digest of each.

Every refusal of a sign-in is the same code and the same message whatever went
wrong, and the same work is done for an unknown address as for a known one:
telling the two apart is an account-enumeration oracle (`docs/SECURITY.md`
section 5). Which it was is recorded in `authentication.login_failed`, where it
informs an operator rather than an attacker. The event never carries the
submitted password, and never the address submitted beside it.

Sign-in is rate limited per subject. Once the limit engages, the refusal is
`RATE_LIMITED` with `details.retry_after_ms`, and a correct password is refused
for the duration too.

Sessions rotate: signing in revokes the session the request arrived with, and
claiming the installation revokes every session the account held. Both record
`session.revoked` with reason `rotated`. Signing out revokes with reason
`sign_out`; `DELETE /api/v1/auth/sessions` revokes every session the account
holds, including the one that asked.

#### CSRF

A state-changing request authenticated by cookie MUST carry the session's CSRF
token in `X-CSRF-Token`. A missing, malformed or foreign token is refused with
`AUTHORISATION_DENIED` and `details.reason: "csrf_token_invalid"`.

A request authenticated by a bearer token does not carry one and does not need
one: a browser does not attach an `Authorization` header to a cross-site
request. A session with no CSRF token — the ADR-0016 exchange of section 4.1 —
therefore cannot reach a state-changing route at all, which is what keeps it the
read-only credential that ADR-0016 describes.

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

`DELETE /api/v1/auth/viewer-sessions/current` ends the session the cookie names,
and it ends **whatever kind** that session is: the exchange of this section and
a local account of section 4.0 share one record. So it applies the CSRF rule by
what the session carries. A session with a CSRF token — every account session —
MUST present it, or the route answers `AUTHORISATION_DENIED` and revokes
nothing. A session issued by this exchange carries none and may still end
itself: a session that cannot be ended is worse than one whose sign-out can be
forged, and what a forgery achieves against a read-only viewer session is
logging it out. Either way the revocation records `session.revoked`.

### 4.2 Agent credentials

Agent credentials are issued administratively and used only on `/mcp/v1`
(`docs/SECURITY.md` section 6.3, ADR-0020):

```text
POST   /api/v1/organisations/:organisationId/agent-credentials
DELETE /api/v1/agent-credentials/:credentialId
```

The issuing call takes `project_ids`, `capabilities`, `label` and an optional
`ttl_seconds` (at least 60, at most 86400) and returns the token **once**:

```json
{
  "data": {
    "credential_id": "agc_...",
    "token": "rpa_...",
    "project_ids": ["prj_..."],
    "capabilities": ["review:read", "review:write", "finding:read", "finding:write", "verification:submit", "browser:capture"],
    "expires_at": "2026-07-30T11:41:02Z",
    "expires_in_seconds": 3600
  }
}
```

There is no route that shows a token again, and the database stores only its
digest. Issuing one records an `agent_credential.issued` event for each project
it is bound to.

### 4.3 Workspace registration

Stage 1's connector reports the checkout an agent is working in. Stage 0
registers it administratively, because MCP session initialisation has to answer
with a branch and a head commit and an invented value would be worse than an
absent one (`docs/DOMAIN_MODEL.md` section 9):

```text
PUT /api/v1/projects/:projectId/workspaces
GET /api/v1/projects/:projectId/workspaces
```

`PUT` takes `root_path`, `branch`, `head_commit` and optional `dirty`, and
upserts on `(project_id, root_path)`. The recorded branch is what
`finding_submit_verification` checks a claimed fix against.

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

`meta` is the same shape on success and on refusal, so a caller quotes one
identifier when reporting either. `request_id` is minted by the control plane
when the caller supplies no `X-Request-Id`, and it is the correlation identifier
that appears in the event records the request produced
(`docs/ARCHITECTURE.md` section 15).

The refusal body, the `meta` block and the stable code enumeration are defined
once, in `packages/protocol/schemas/platform/v1.schema.json`, and generated into
TypeScript and Go from there (ADR-0013). `data` is endpoint-specific and is
therefore defined by the endpoint's own schema.

`details` is a fixed vocabulary rather than a free object: `current_version` and
`expected_version` for `VERSION_CONFLICT`, `current_epoch` for
`CONTROL_EPOCH_STALE`, `candidates` for `PROJECT_CONTEXT_AMBIGUOUS`,
`allowed_transitions` for a refused transition, `required_evidence` for
`EVIDENCE_REQUIRED`, `missing_context` for an incomplete capture,
`retry_after_ms` for `RATE_LIMITED`, and `field` and `reason` where one code
covers several causes. Constraining it is what stops a handler attaching a
request body or a credential to a refusal (`docs/SECURITY.md` section 18).

A refusal MUST NOT disclose the existence of a resource in another project. A
foreign identifier is answered `RESOURCE_NOT_FOUND`, never
`AUTHORISATION_DENIED`, because the second answer confirms that the resource
exists.

### 5.1 Idempotency

A state-changing request MAY carry `Idempotency-Key`. The key is scoped to the
actor, the operation and the project (`docs/MCP_SPEC.md` section 10): replaying
it with the same input returns the original result and runs the operation once,
and reusing it with different input is refused with `IDEMPOTENCY_CONFLICT`. A
duplicate that arrives while the first call is still in flight is answered
`RATE_LIMITED` with `details.retry_after_ms` rather than allowed to run
concurrently.

### 5.2 Optimistic concurrency

A write to a collaborative record carries `expected_version`. A mismatch is
refused with `VERSION_CONFLICT` and `details.current_version`, so a caller can
re-read and retry rather than guess.

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

`next_cursor` is absent on the last page rather than present and null. `limit`
defaults to 50 and MUST NOT exceed 200; a value outside that range is refused
with `VALIDATION_FAILED`.

Pagination is keyset rather than offset: the cursor names the last row of the
previous page. An offset shifts when a row is inserted, which would make a
caller paging through a busy project silently skip rows.

A cursor MUST be treated as opaque and MUST NOT be constructed, parsed or
modified by a client. One the API did not issue is refused with
`VALIDATION_FAILED` rather than treated as the first page: answering with a
different page would lose rows without saying so.

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

`GET /api/v1/organisation` is implemented and answers the organisation the
caller's session belongs to. The `/api/v1/members*` routes remain reserved and
unimplemented: memberships, invitations and roles are Stage 3
(`docs/DOMAIN_MODEL.md` section 5).

`PATCH /api/v1/organisation` is not implemented yet. Stage 1 seeds exactly one
organisation, and renaming it is not a capability any flow needs before
memberships exist.

Two administrative provisioning routes exist outside this list and are reachable
only with the bootstrap administrator token:

```text
POST /api/v1/organisations
POST /api/v1/organisations/:organisationId/projects
```

They are how a test harness, the fixture capture and the Compose end-to-end
scenario seed a deployment without a browser. They are not part of the human
API, and a human session cannot reach them.

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

`GET /api/v1/projects` and `GET /api/v1/projects/:projectId/activity` are
paginated per section 6. The activity endpoint is the project event timeline:
the same envelopes the WebSocket channel of section 18.1 delivers live, newest
first. Both resolve the project inside the caller's scope, so a project the
caller may not see answers exactly as an unknown identifier does.

### 8.1 The project representation

A project answers with the record of `docs/DOMAIN_MODEL.md` section 6, whose
shape is defined once in `packages/protocol/schemas/platform/v1.schema.json`:

```json
{
  "id": "prj_...",
  "organisation_id": "org_...",
  "name": "Refresh Surplus",
  "slug": "refresh-surplus",
  "repository_identity": {
    "canonical": "github.com/example/refresh-surplus",
    "clone_urls": ["git@github.com:example/refresh-surplus.git"]
  },
  "default_branch": "main",
  "status": "active",
  "settings": {
    "default_validation_viewports": [
      { "width": 390, "height": 844 },
      { "width": 1440, "height": 900 }
    ]
  },
  "version": 3,
  "created_at": "2026-07-30T09:00:00Z",
  "updated_at": "2026-07-30T09:12:44Z"
}
```

- **Reads** are available to any human session, filtered by its scope.
- **Writes** are organisation administration: an organisation-wide session
  performs them; a session scoped to a project does not, and no machine
  credential does. A cookie-authenticated write also carries the CSRF token of
  section 4.0.
- `POST` takes `name` and optionally `slug`, `repository_identity`,
  `default_branch` and `settings`. The slug is derived from the name when it is
  not supplied.
- `repository_identity` accepts a clone URL as a string, or an object holding
  `clone_urls`. It is normalised to the provider-agnostic canonical form before
  storage: the scheme, any `userinfo`, a default port, a `.git` suffix and
  trailing slashes are removed and the host is lowercased. Credential material
  in a clone URL is dropped rather than stored — over `http` and `https` the
  whole `userinfo` component goes, because a bare userinfo there is a personal
  access token in every forge's documented clone command; over `ssh` a bare
  username is kept, because it names the account and the secret is a key on
  disk, while a `user:password` pair is dropped. Clone URLs that reduce to
  different repositories are refused with `VALIDATION_FAILED` and
  `details.reason: "inconsistent_urls"`.
- `settings.default_validation_viewports` defaults to 390x844 and 1440x900 and
  is bounded by the browser protocol's viewport bounds: a viewport a browser
  session could not adopt cannot be stored.
- A slug already used in the organisation is refused with `VALIDATION_FAILED`
  and `details.reason: "slug_not_unique"`. The uniqueness is the database's, so
  two concurrent creations of one slug produce exactly one project and one
  refusal.
- `PATCH` accepts `expected_version` (section 5.2) and answers a mismatch with
  `VERSION_CONFLICT` carrying both `current_version` and `expected_version`.
  `DELETE` accepts it as a query parameter.
- `DELETE` archives: `status` becomes `archived` and the record, its reviews,
  its evidence and its audit trail all survive. Archiving an archived project
  changes nothing and records nothing. `GET /api/v1/projects` omits archived
  projects unless `include_archived=true`.

Events: `project.created`, `project.updated`, `project.repository_changed` and
`project.archived`.

`project.updated` names every attribute whose **stored value** moved, compared
against the row rather than against which members the request carried:
`repository_identity` appears there like any other. A `PATCH` that names
attributes but moves none writes no event and does not bump the version, so
repeating a request cannot manufacture history.
`project.repository_changed` is written only when the canonical identity moves —
adding a clone URL for the repository a project already points at is an update,
not a change of repository.

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

### Administrative authentication on this surface

These endpoints require the bootstrap administrator token of `ARCHITECTURE.md`
§11 as `Authorization: Bearer <token>`, compared in constant time and never
logged. A connector credential — its identity, certificate, fingerprint or
enrolment token — MUST NOT be accepted here (`TESTING.md` §10).

Local accounts arrived with section 4.0 and have not yet replaced the token on
these connector routes: enrolling an environment from the web application is the
connector-enrolment slice rather than this one. A human session therefore does
not reach them today, and the token is what an operator and the end-to-end
harness use.

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

`POST /api/v1/projects/:projectId/reviews` requires the captured source context
of `docs/DOMAIN_MODEL.md` section 14 — `captured_branch`, `captured_commit`,
`captured_workspace_id` and `source_browser_session_id` — and a project-scoped
`slug`. A review is created `DRAFT` or `READY`; every other status is reached
by a transition. A slug that is already in use by an **active** review of the
same project is refused with `IDEMPOTENCY_CONFLICT`; the same slug in another
project is unrelated. Active means every status except `CANCELLED` and
`ARCHIVED`, so a withdrawn review releases its name and an accepted one keeps
it: an agent told to work on `bugs-on-homepage` must never face two candidates.

`GET /api/v1/projects/:projectId/reviews?slug=...` is the named lookup an agent
uses; it searches active reviews only.

`ACCEPTED`, `CANCELLED` and `ARCHIVED` reviews are immutable except for
archival metadata (`docs/DOMAIN_MODEL.md` section 14). An ordinary edit is
refused with `POLICY_DENIED` rather than silently dropped. Only a `human_user`
actor may move a review to `ACCEPTED`.

The request and response bodies are the `review_create_request`,
`review_update_request` and `review` schemas of
`packages/protocol/schemas/review/v1.schema.json`, and the server validates
against the generated validator before any domain code runs.

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

Updates include `expected_version`. A mismatch is refused with
`VERSION_CONFLICT` and the version the record actually holds, so a caller can
re-read and retry rather than guess.

`POST /api/v1/reviews/:reviewId/findings` requires the captured context of
`docs/UX_FLOWS.md` section 9: `url`, `viewport` including
`device_scale_factor`, `scroll_position`, `captured_commit` and
`screenshot_artefact_id`. A request missing any of them is refused with
`UNSUPPORTED_CAPABILITY` and a `missing_context` list; a finding that cannot be
reproduced later is not stored incomplete. `element_context` is optional
because the flow itself marks it "if available". The screenshot artefact must
already be `available` — an unverified artefact is refused with
`ARTEFACT_UPLOAD_INCOMPLETE` — and must belong to the same project. Annotations
may be supplied inline, and are then written in the same transaction as the
finding.

Status transitions are checked in this order: version, transition legality,
actor authority, completion evidence. A human-authored finding cannot be set to
`RESOLVED`, `WONT_FIX` or `DUPLICATE` by an agent
(`AUTHORISATION_DENIED`); the transitions an agent may perform are the
`docs/MCP_SPEC.md` section 7.7 list and nothing else (`POLICY_DENIED`);
and a move to `FIXED_UNVERIFIED` without a resolution note is refused with
`EVIDENCE_REQUIRED`. These are domain rules, enforced below the transport, so
they hold for the MCP surface as well as for this one.

## 14. Annotation endpoints

```text
POST   /api/v1/findings/:findingId/annotations
GET    /api/v1/findings/:findingId/annotations
PATCH  /api/v1/annotations/:annotationId
DELETE /api/v1/annotations/:annotationId
```

Annotation changes preserve revision history even if the current projection hides deleted revisions.
`GET .../annotations` returns the current projection: the newest revision of
each annotation, with withdrawn ones hidden. `?revisions=all` returns every
revision, because the history is retained rather than overwritten.

Geometry is normalised to the artefact content rectangle
(`docs/DOMAIN_MODEL.md` section 16). Every member must lie between 0 and 1
inclusive, and which members a type carries is fixed by that section. A value
outside the range, or a member a type does not use, is **refused** with
`UNSUPPORTED_CAPABILITY` and never clamped: a clamped coordinate produces an
overlay that looks plausible and is in the wrong place. The annotation's
`artefact_id` must be the finding's own screenshot.

## 15. Artefact endpoints

```text
POST   /api/v1/projects/:projectId/artefacts/uploads
POST   /api/v1/artefacts/:artefactId/content
POST   /api/v1/artefacts/:artefactId/complete
GET    /api/v1/artefacts/:artefactId
POST   /api/v1/artefacts/:artefactId/grants
GET    /api/v1/artefact-content/:grantId
DELETE /api/v1/artefacts/:artefactId
```

### Upload flow

1. Create upload intent with kind, size and hash.
2. Receive short-lived upload URL or proxied upload endpoint.
3. Upload content.
4. Complete with observed hash.
5. Server verifies before making artefact available.

Under the `filesystem` driver step 2 returns `upload_path`, the proxied endpoint above; the `s3` driver may return a presigned URL instead. Step 5 is the whole point of the flow: the server recomputes the digest of the bytes it stored and compares it with both the declared and the observed value. Until that succeeds the artefact stays `pending` or `uploaded`, no grant may be minted for it — the attempt is refused with `ARTEFACT_UPLOAD_INCOMPLETE` — and no caller may treat it as evidence. A mismatch marks the artefact `failed` and records `artefact.upload_failed`.

Verification also decides what the bytes are and how large the picture in them
is. The declared media type is a claim; the leading bytes are evidence, and a
mismatch — an SVG or an HTML document uploaded as `image/png` — is refused on
upload with `UNSUPPORTED_CAPABILITY` and marks the artefact `failed`. For an
image the server measures the intrinsic pixel extent and records it as
`content_rectangle`, because that rectangle is the reference frame every
annotation on the artefact is normalised against (`docs/DOMAIN_MODEL.md`
section 16) and an uploader that could choose it could move every existing
mark. `filename` on the intent is display metadata only: it never reaches the
content-addressed storage key, and a value that is a path rather than a name is
refused.

### Reading content back

Artefact bytes are reachable only through a short-lived, subject-bound grant
(ADR-0019, ADR-0012, `docs/SECURITY.md` section 13). There is no route that
serves an artefact from its identifier.

```json
{
  "grant_id": "agr_...",
  "artefact_id": "art_...",
  "url": "/api/v1/artefact-content/agr_...",
  "expires_at": "2026-07-30T10:14:04.118Z",
  "expires_in_seconds": 120
}
```

`GET /api/v1/artefact-content/:grantId` resolves the grant, authenticates the
caller independently, and requires the caller to be the grant's subject. An
unknown, expired or revoked grant is refused with `AUTHENTICATION_REQUIRED`; a
live grant presented by another principal with `AUTHORISATION_DENIED`. The
grant identifier therefore travels safely in a URL — which is what an `<img>`
element needs — while the credential stays in the cookie or the `Authorization`
header, as `docs/SECURITY.md` section 18 requires. Minting a grant records
`artefact.access_granted`.

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

Authentication and authorisation both complete **before the upgrade**, as they
do on the live channel of section 18.2: an anonymous subscriber, a subscriber
scoped to another project and an unknown project identifier are all refused with
an HTTP status on the handshake, so no WebSocket exists for them and no event is
transmitted. A project outside the subscriber's scope answers `404`
`RESOURCE_NOT_FOUND`, identically to one that does not exist. The `Origin`
header is checked against the configured allow list.

The channel's messages are defined once, in
`packages/protocol/schemas/platform/v1.schema.json`, and are not restated here:

| Message | Direction | Purpose |
|---|---|---|
| `stream.subscribe` | subscriber to control plane | Opens the subscription at the last sequence the client applied, with the largest replay it will accept |
| `stream.subscribed` | control plane to subscriber | Acceptance, stating the current sequence, the oldest replayable sequence and whether a replay follows |
| *event envelope* | control plane to subscriber | One event of `docs/EVENTS.md` section 2, replayed or live |
| `stream.refresh_required` | control plane to subscriber | The client's position cannot be replayed; it MUST refetch state and resume from `current_sequence` |
| `stream.heartbeat` | control plane to subscriber | Liveness on a quiet project, carrying the sequence the stream is at |
| `stream.error` | control plane to subscriber | A refusal on an open subscription, with a stable code from section 5 |

An event envelope and a control message are distinguished by one member: an
event's `type` is an event name, a control message's `type` is a `stream.`
discriminator. A message that is neither is refused rather than ignored.

A subscriber resumes without loss or duplication: the control plane attaches to
live delivery before it replays history, and discards buffered events at or
below the last replayed sequence. `GET /api/v1/projects/:projectId/activity`
serves the same events as pages, and is what a client refetches from after a
refresh instruction.

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

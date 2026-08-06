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
`AUTHORISATION_DENIED` and `details.reason: "csrf_token_invalid"`, before the
request body is validated, so a forged request is refused rather than answered
with a validation error.

A request authenticated by a bearer token does not carry one and does not need
one: a browser does not attach an `Authorization` header to a cross-site
request.

A session with no CSRF token — the ADR-0016 exchange of section 4.1 — cannot
satisfy the check. No route that authenticates it by cookie therefore changes
state for it, with exactly one exception: `DELETE
/api/v1/auth/viewer-sessions/current`, which ends the calling session and
applies the rule conditionally, by what the session carries (section 4.1).
Everything that changes a project, a review, a finding, an annotation or an
artefact grant applies the rule unconditionally, so the exchange remains the
read-only credential that ADR-0016 describes: it can end itself, and it can
change nothing else.

Two state-changing routes here authenticate by neither cookie nor bearer:
`POST /api/v1/auth/bootstrap` and `POST /api/v1/auth/sessions` carry their own
credential in the body, so there is no session for a CSRF token to belong to.
They are guarded instead by `REVIEWPLANE_ALLOWED_ORIGINS`: where a deployment
configures the list, a request whose `Origin` is not on it is refused with
`AUTHORISATION_DENIED`, which is what stops another site signing somebody in or
claiming an unclaimed installation. Where it configures none, these two routes
apply no origin check and rely on `SameSite=Strict` alone
(`docs/CONFIGURATION.md` section 2.1).

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
forged. What that costs is bounded by the unconditional rule everywhere else,
and only by it: a session with no CSRF token can reach no other state-changing
route, so the whole of what a forged request achieves against one is ending it,
after which an operator obtains another by presenting the bootstrap token again.
Either way the revocation records `session.revoked`.

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
    "capabilities": ["review:read", "review:write", "finding:read", "finding:write", "verification:submit", "browser:capture", "browser:control", "service:publish"],
    "expires_at": "2026-07-30T11:41:02Z",
    "expires_in_seconds": 3600
  }
}
```

There is no route that shows a token again, and the database stores only its
digest. Issuing one records an `agent_credential.issued` event for each project
it is bound to.

### 4.3 Workspace registration

A workspace reaches the control plane two ways, and both are supported. A
connector reports the checkouts it was configured with, as bounded Git context
on its own channel (`CONNECTOR_PROTOCOL.md` §9, ADR-0022). An operator or an
agent session registers one directly through the routes below, which is what a
project with no connector uses — MCP session initialisation has to answer with a
branch and a head commit, and an invented value would be worse than an absent
one (`DOMAIN_MODEL.md` §9):

```text
PUT /api/v1/projects/:projectId/workspaces
GET /api/v1/projects/:projectId/workspaces
```

`PUT` takes `root_path`, `branch`, `head_commit` and optional `dirty`. It
upserts on `(project_id, path_hash)` among the workspaces that belong to no
environment, which is what a workspace registered here is. The target is the
path hash rather than the path, because a connector-reported workspace stores no
path at all and a conflict target naming one could never match its row; and it
is qualified by the absent environment because a checkout at the same path on a
development machine is a different record, owned by the environment that
reported it (`DOMAIN_MODEL.md` §9).

Both sides hash the same bytes, so a checkout registered here and later observed
by a connector resolves to one record rather than two: the connector adopts the
registered row and its `source` moves to `connector_report`.

Adoption is bounded twice. It reaches only a record with no environment — a
record another environment owns is refused, so registering a workspace is not a
way to hand one machine's checkout to another. And it requires the **path hash
to match**: naming a registered workspace's identifier while reporting a
different path is refused, because otherwise the record would keep the
`root_path` an operator supplied — which `MCP_SPEC.md` §4 resolves a
`workspace_hint` against — while its digest, label, branch and head commit came
from a machine that has never seen that directory.

The recorded branch is what `finding_submit_verification` checks a claimed fix
against.

A workspace registered here retains its `root_path`, because `workspace_hint`
resolves against it (`MCP_SPEC.md` §4). A connector-reported one does not: the
path never leaves the development machine.

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
  `clone_urls`. Four schemes are accepted — `https`, `http`, `ssh` and `git` —
  along with Git's scp-like `user@host:path` and the bare `host/path` a person
  types. It is normalised to the provider-agnostic canonical form before
  storage: the scheme, any `userinfo`, a default port, a `.git` suffix and
  trailing slashes are removed and the host is lowercased. Credential material
  in a stored clone URL is dropped rather than kept — over `ssh` a bare username
  is kept, because it names the account and the secret is a key on disk, while a
  `user:password` pair is dropped; under every other scheme the whole `userinfo`
  component goes, because over `https` and `http` a bare userinfo is a personal
  access token in every forge's documented clone command, and `git` is the
  unauthenticated daemon protocol, which has no credential mechanism for a
  userinfo to belong to. Clone URLs that reduce to different repositories are
  refused with `VALIDATION_FAILED` and `details.reason: "inconsistent_urls"`.
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
    "enrolment_endpoint": "wss://agents.example.internal/connector/v1/enrol",
    "control_plane_url": "wss://agents.example.internal",
    "connector_command": "sudo reviewplane-connector enrol \\\n  --control-plane https://agents.example.internal \\\n  --token-file /root/reviewplane-enrolment-token"
  },
  "meta": { "request_id": "req_..." }
}
```

`connector_command` is the ready-to-run command `UX_FLOWS.md` §5 asks the enrolment screen to display, assembled by the control plane so that every surface shows the same one. It reads the token from a **file** rather than from a command line, because a command line is in the process table and in shell history (`CONNECTOR_PROTOCOL.md` §20). The connector dials over `wss` and an operator types an `https` base URL, so the advertised origin is rendered back as the `https://` form `--control-plane` accepts; `control_plane_url` carries the advertised origin itself for a caller assembling something else.

`project_id` is resolved inside the caller's scope. A project the caller cannot reach is refused as an absent project rather than as a forbidden one.

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

### Environment views

`GET /api/v1/projects/:projectId/environments` returns the project's
environments; `GET /api/v1/environments/:environmentId` returns one. Both carry
the environment's own record plus nested `connectors` and `workspaces` arrays,
because the question an operator is asking — is this machine connected, and what
does it have checked out — is answered by all three together and would otherwise
take three round trips and a join in the client.

```json
{
  "data": {
    "id": "env_...",
    "organisation_id": "org_...",
    "project_id": "prj_...",
    "name": "dev-ai-03",
    "platform": "linux",
    "architecture": "amd64",
    "labels": ["proxmox", "development"],
    "trust_level": "standard",
    "status": "ACTIVE",
    "last_seen_at": "2026-07-31T09:12:04.000Z",
    "created_at": "2026-07-30T18:02:11.000Z",
    "connectors": [
      {
        "id": "con_...",
        "environment_id": "env_...",
        "project_id": "prj_...",
        "certificate_fingerprint": "sha256:...",
        "version": "0.1.0",
        "capabilities": ["http-tunnel", "websocket-tunnel", "git-context", "local-mcp-bridge"],
        "status": "ACTIVE",
        "connected_at": "2026-07-31T09:00:00.000Z",
        "last_heartbeat_at": "2026-07-31T09:12:04.000Z",
        "revoked_at": null
      }
    ],
    "workspaces": [
      {
        "id": "wsp_...",
        "project_id": "prj_...",
        "path_hash": "sha256:...",
        "display_path": "refresh-surplus",
        "repository_identity": "github.com/example/refresh-surplus",
        "branch": "main",
        "head_commit": "d191e28...",
        "dirty": false,
        "source": "connector_report",
        "last_observed_at": "2026-07-31T09:11:58.000Z"
      }
    ]
  },
  "meta": { "request_id": "req_..." }
}
```

A workspace carries `display_path` and `path_hash` and no root path: a
connector-reported checkout's filesystem path never leaves the development
machine (`DOMAIN_MODEL.md` §9). `source` distinguishes a checkout a connector
observed from one an operator or agent session registered. Every value in these
two arrays was reported by another machine and is description, never an
authorisation input.

`GET /api/v1/connectors/:connectorId` returns one connector with the same
summary plus `certificate_not_after` and its nested `environment`, so that an
operator can see when the identity expires without exporting the certificate.

### Revocation

`POST /api/v1/connectors/:connectorId/revoke` invalidates one connector identity
(`CONNECTOR_PROTOCOL.md` §18). It is irreversible: re-enrolment creates a new
connector identity rather than restoring this one.

```json
{
  "data": {
    "id": "con_...",
    "status": "REVOKED",
    "revoked_at": "2026-07-31T09:20:00.000Z",
    "routes_revoked": 2,
    "sessions_disconnected": 1,
    "channels_closed": 1,
    "agent_credentials_revoked": 1,
    "already_revoked": false
  },
  "meta": { "request_id": "req_..." }
}
```

The four counts say what the revocation actually reached, so a screen can
report it rather than implying more or less than happened; `sessions_disconnected`
counts browser sessions moved to `DEGRADED`, which is what losing a connector
does to a session (`DOMAIN_MODEL.md` §12), and `agent_credentials_revoked`
counts the live agent credentials the connector had minted for a local MCP
bridge (`CONNECTOR_PROTOCOL.md` §18, ADR-0023), which stay usable until
something revokes them. Revoking an already-revoked connector is not an error:
it answers `already_revoked: true` and changes nothing, so a retried request
cannot produce a second set of counts for work that happened once.

### Administrative authentication on this surface

These endpoints require an organisation administrator. Two credentials satisfy
that: a human session cookie from section 4.0, and the bootstrap administrator
token of `ARCHITECTURE.md` §11 as `Authorization: Bearer <token>`, compared in
constant time and never logged. Enrolling an environment from the web
application is what added the first; the token continues to work unchanged, and
is what an operator with a shell and no browser, and the end-to-end harness, use.

The caller MUST be an **organisation-wide** session. A session scoped to a
project is a delegation for that project and does not administer the
organisation, so it is refused `AUTHORISATION_DENIED`. A machine credential —
browser worker, agent, or a connector's own identity, certificate, fingerprint
or enrolment token — MUST NOT be accepted here at all (`TESTING.md` §10).

Every state-changing route on this surface — `POST …/enrolment-tokens` and
`POST …/:connectorId/revoke` — applies the strict CSRF guard of section 4, in an
**`onRequest`** hook so that it runs **before the request body is decoded**. The
phase is the whole of the claim: a guard in `preHandler` runs after parsing, so
a refusal there would still have spent the work an attacker asked for. The guard is what makes cookie authentication safe here: a browser attaches
a cookie to a request another origin caused and does not attach a bearer token,
so the cookie alone must not be sufficient. Minting an enrolment token is
exactly the shape that must not be forgeable — it is a credential that enrols a
machine — and revoking a connector is exactly the shape that must not be
forgeable in the other direction.

Every lookup on this surface carries the identifier, the organisation and the
session's project scope in one predicate. A connector or environment outside the
caller's scope produces no row, so a foreign identifier and an unknown one answer
`RESOURCE_NOT_FOUND` byte-identically and neither can be used to enumerate the
other (§5). A test asserts the two response bodies are identical rather than
merely equivalent.

## 10. Published-service endpoints

```text
GET    /api/v1/projects/:projectId/published-services
POST   /api/v1/projects/:projectId/published-services
DELETE /api/v1/published-services/:serviceId
POST   /api/v1/published-services/:serviceId/capabilities
```

Creation requires connector, workspace, local destination and TTL. The local destination MUST satisfy the destination policy of `SECURITY.md` §9 before any record is written, so a refused destination never produces a published-service row or an event. The requested TTL MUST NOT exceed the configured maximum route lifetime.

Every route on this surface is an organisation administrator's
(`SECURITY.md` §7): the three state-changing ones apply the strict CSRF guard in
an **`onRequest`** hook, so a cookie session must present its token **before the
body is decoded**, and a bearer credential carries none and needs none.

**Every identifier in the body is resolved inside the caller's scope, not just
the project.** `connector_id`, `workspace_id` and every entry of
`allowed_browser_session_ids` MUST name a record in the caller's organisation
and in the project named in the path; one that does not is refused before any
row is written, identically to an identifier that names nothing. Resolving only
the project was not enough in two ways that mattered: a caller could name
another organisation's connector and fill its per-connector route limit, and a
caller could name another organisation's **browser session**, after which a
capability minted against that route would bind it — because minting checked
only against this same caller-supplied list. `allowed_browser_session_ids` is
therefore a request for authorisation and never a grant of it.

A connector enrolled with an organisation-scoped token serves any project in its
organisation (`CONNECTOR_PROTOCOL.md` §4.1) and is accepted here; one enrolled
for a project may be named only for that project. A `connector_id` that matches
no record answers `RESOURCE_NOT_FOUND`, like any other absent identifier;
`CONNECTOR_OFFLINE` is reserved for a connector this deployment **has** and
cannot currently reach, which is the state `UX_FLOWS.md` §18 calls "no connector
connected". The two are different questions and MUST NOT share a code.

Reads are scoped the same way: a route or a project outside the caller's scope
answers `RESOURCE_NOT_FOUND` byte-identically to one that does not exist (§5).
`DELETE` is the one that matters most: it names a route and no project, so the
scope has nowhere to come from but the principal.

`POST` may answer with the record in `requested` rather than `ready` when the
process serving it does not hold the connector's control channel. It does hold
one, so in practice this endpoint completes the publication inline; the
two-phase shape exists for the agent surface and is ADR-0021.

The response is the published-service record of `DOMAIN_MODEL.md` §10 as this
API projects it, not the `published_service` entity of
`packages/protocol/schemas/platform/v1.schema.json`. The two differ
deliberately: the entity is the durable record, and this view adds
`internal_origin` and renders every absent member as `null` rather than omitting
it, so a client can read a field without checking whether it exists.

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

### Who may call these endpoints

A human session scoped to the project, or the bootstrap administrator token,
which maps to an organisation-wide human principal (ADR-0016). `UX_FLOWS.md` §6
requires a reader to start a session from the project Live page, so these are not
administrator-only routes; every state-changing one applies the CSRF rule of §4,
because a cookie can authenticate them and starting a browser session opens a
central Chromium against a private development machine. A browser-worker, agent
or connector credential reaches none of them (`SECURITY.md` §6.3); an agent acts
through `/mcp/v1`.

Worker assignment (`PUT /api/v1/browser-workers/:workerId/assignments`) and the
worker listing remain organisation-wide: a project-scoped session may not assign
a worker.

Every session lookup is filtered by the caller's project scope and organisation
in one predicate, so a session in another project answers `RESOURCE_NOT_FOUND`
byte for byte as an unknown identifier does (§5).

### Command request

```json
{
  "control_epoch": 12,
  "command": {
    "command": "navigate",
    "timeout_ms": 30000,
    "navigate": {"url": "/checkout", "wait_until": "domcontentloaded"}
  }
}
```

The command body is the `browser_command` of `packages/protocol/schemas/browser/v1.schema.json`.

`controller` is **not** part of this request and MUST NOT be sent; a body that
carries one is refused with `VALIDATION_FAILED`. It appeared here until RVP-30,
and it was an impersonation surface: a controller in a request body is a claim
*about* the actor rather than the actor, so the lease-ownership check of
`SECURITY.md` §7 could be satisfied by naming its owner. The control plane
derives the controller from the authenticated principal — a human acts as the
`system` controller bound to their session, an agent as its own agent session
(ADR-0028).

All six checks of `SECURITY.md` §7 run before the command reaches the worker. A
stale `control_epoch` returns `CONTROL_EPOCH_STALE` with `details.current_epoch`;
a caller that does not hold the lease and is not issuing a non-interactive system
capture returns `CONTROL_NOT_OWNED`; a paused session returns
`BROWSER_SESSION_NOT_ACTIVE` for an interactive command and admits a capture; a
route that no longer authorises the session returns `AUTHORISATION_DENIED` on
navigation; a value that looks like secret material returns `POLICY_DENIED`
naming the shape and never the value. Every one of them is recorded as
`browser.command_rejected` (`EVENTS.md` §7).

Responses carry the `browser_command_result`, whose `trust` and
`instruction_policy` fields the schema requires on every result.

### Start request

```json
{
  "published_service_id": "svc_...",
  "viewport": {
    "width": 1440,
    "height": 900,
    "device_scale_factor": 1
  }
}
```

`viewport` is required. `organisation_id` is **derived from the project** in the
path and does not need to be sent; it is still accepted for compatibility and is
refused with `VALIDATION_FAILED` when it disagrees with the project's
organisation, rather than ignored — a caller that believes it chose the
organisation and did not is worse off than one that is told. On a project route
an organisation the caller names is an authorisation input the caller chose,
which §5 and `SECURITY.md` §7 both forbid.

`controller` is **not** accepted and a request carrying one is refused with
`VALIDATION_FAILED`. Creation derives the controller from the authenticated
caller like every other route on this surface. It is a weaker case than the
others — no session exists yet, so nothing is being seized, and the creator
plainly has authority over what it creates — but it is the same shape and it had
the same consequence: a caller could name an identity it is not, including one
that does not exist, and the session's lease would belong to it. The creator
would then hold no lease on its own session and could not end it without taking
control first, while the slot counted against the worker's capacity. Use
`agent_session_id` to associate a session with an agent; unlike a controller
identity, it is a foreign key and a fabricated one is refused.

An agent starting its own session through `browser_session_start` does hold the
lease, because the MCP server derives that controller from the credential behind
the connection rather than from a request body.

`published_service_id` names the route the session may reach; the control plane
resolves the origin from that record and mints the session-scoped capability
itself. Neither the origin nor the capability is accepted from the caller: the
origin *is* the worker's egress allow-list (`SECURITY.md` §9) and the capability
is a bearer credential the control plane alone mints (`ARCHITECTURE.md` §7.3).

Stage 1 does not implement trace or video capture, so `trace_enabled` and
`video_enabled` are not part of this request. Trace capture arrives in Stage 2
and video stays disabled.

When no live browser worker has capacity the request is refused with
`BROWSER_CAPACITY_EXHAUSTED`. A registered worker that has stopped heartbeating
is **not** counted as capacity (ADR-0027), so this is the answer an operator
receives when the worker container has stopped — rather than a session that never
becomes ready.

### Pause, resume and control

```text
POST /api/v1/browser-sessions/:sessionId/pause
POST /api/v1/browser-sessions/:sessionId/resume
POST /api/v1/browser-sessions/:sessionId/control/request
POST /api/v1/browser-sessions/:sessionId/control/release
```

`pause`, `resume`, `control/release` and `terminate` all take
`{"control_epoch": 12}`, and it is **required**: a request that omits it is
refused with `VALIDATION_FAILED`. There is no fallback to the session's own
epoch, and the absence of one is load-bearing. A route that filled the epoch in
from the record it was about to authorise against would be comparing the record
to itself, and the ownership and epoch checks of `SECURITY.md` §7 would pass for
any caller who could reach the route — which is precisely what these four routes
did until the adversarial review of RVP-30. The guard only caught a caller who
*volunteered* a wrong epoch, which no attacker does.

The controller is likewise derived from the authenticated caller on all four,
exactly as on `commands`.

A pause suspends interactive
commands and leaves non-interactive system capture and live frames running
(`MCP_SPEC.md` §7.3): the browser context stays open, so a pause is a change of
authority rather than a blackout. Resuming returns the session to `READY` rather
than `ACTIVE`, because a resumed session has been sitting and the page may have
moved; the first successful command moves it to `ACTIVE` again.

`control/request` takes `{"controller_type": "system" | "human", "reason":
"..."}` and transfers the interactive lease, incrementing the control epoch in
the same transaction. Requesting control the caller already holds is idempotent
and does **not** increment.

`controller_id` is **not** accepted and a request carrying one is refused with
`VALIDATION_FAILED`. It let any project member plant a lease owned by an
identity that does not exist and revoke the incumbent's as a side effect, since
taking control revokes what it supersedes. A controller identity a caller names
is the same claim-about-the-actor this API refuses on `commands`.

`controller_type: "human"` is refused with `UNSUPPORTED_CAPABILITY` in Stage 1 —
takeover through the control WebSocket is Stage 2 — and the refused request is
still audited as `browser.control_requested` with `granted: false`.
`controller_type: "agent"` is refused on this route with `AUTHORISATION_DENIED`:
a human cannot take control *on behalf of* an agent. An agent session requests
control under its own identity through `/mcp/v1`.

`controller_type: "system"` is how a human **reclaims** a session whose lease
somebody else holds. It is not a bypass: the epoch moves, so the incumbent's
in-flight commands are refused with `CONTROL_EPOCH_STALE` rather than silently
overtaken, and `browser.control_transferred` records it. That is the Stage 1
path for ending or pausing a session an agent is driving — a lifecycle route
alone will refuse with `CONTROL_NOT_OWNED`, because pausing or ending a browser
somebody else controls is not a lesser act than clicking in it.

`control/release` takes `{"control_epoch": 12}` and also increments the epoch:
after a release nobody holds the lease, and a command still carrying the released
epoch must not pass the epoch check.

### Session timeline

```text
GET /api/v1/browser-sessions/:sessionId/timeline?limit=100
```

Returns the session's events, newest first, from the event store rather than from
a second log — every meaningful state change produces an event, so a timeline
assembled from anything else would be a different set of facts. Each entry is
`{"id", "type", "occurred_at", "actor": {"type", "display"}, "payload"}`. `limit`
is bounded at 200.

A payload here can carry page-derived data: `browser_session.navigated` records
the URL the browser settled on. It is data and never an instruction
(`MCP_SPEC.md` §6).

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
GET    /api/v1/reviews/:reviewId/comments
POST   /api/v1/reviews/:reviewId/comments
PATCH  /api/v1/comments/:commentId
GET    /api/v1/reviews/:reviewId/export
```

Review accept checks that all required human-authored findings are resolved or explicitly waived.

`POST /api/v1/projects/:projectId/reviews` requires the captured source context
of `docs/DOMAIN_MODEL.md` section 14 — `captured_branch`, `captured_commit`,
`captured_workspace_id` and `source_browser_session_id` — and a project-scoped
`slug`. It optionally takes a `priority`, which defaults to `medium` and orders
a queue without gating anything. A review is created `DRAFT` or `READY`; every
other status is reached by a transition. A slug that is already in use by an
**active** review of the same project is refused with `IDEMPOTENCY_CONFLICT`;
the same slug in another project is unrelated. Active means every status except
`CANCELLED` and `ARCHIVED`, so a withdrawn review releases its name and an
accepted one keeps it: an agent told to work on `bugs-on-homepage` must never
face two candidates. Uniqueness is enforced by a partial unique index rather
than by a read followed by a write, so two concurrent creations of one slug
produce one review and one refusal.

`GET /api/v1/projects/:projectId/reviews` pages by the opaque cursor of section
6, newest first. `?slug=...` is the named lookup an agent uses instead; it
searches active reviews only and answers a single-element list.

The four lifecycle routes each fix their own target status rather than taking
one in the body, so a caller cannot ask one route for another's transition. Each
carries `expected_version` and an optional `reason`, which is recorded on the
event and never on the record:

- `request-review` moves the review to `AWAITING_HUMAN_REVIEW`.
- `accept` moves it to `ACCEPTED`. It is refused with `POLICY_DENIED` unless
  every human-authored finding has reached `RESOLVED`, `WONT_FIX` or
  `DUPLICATE`; the refusal names one that has not. The precondition is checked
  inside the transaction that holds the review's row lock, so a finding reopened
  concurrently cannot slip past between the check and the write. Acceptance
  records `review.accepted` beside `review.status_changed`, naming the human who
  decided.
- `reopen` moves it to `CHANGES_REQUESTED`. From `ACCEPTED` this is the explicit
  reopen of `docs/DOMAIN_MODEL.md` section 14 and additionally records
  `review.reopened` with the new `reopen_count`; prior findings, verifications,
  comments and events are all retained.
- `archive` moves it to `ARCHIVED` and records `review.archived` with the status
  it was archived from. Archival is not deletion.

`ACCEPTED`, `CANCELLED` and `ARCHIVED` reviews are immutable except for archival
metadata, comments and an explicit reopen (`docs/DOMAIN_MODEL.md` section 14). An
ordinary edit is refused with `POLICY_DENIED` rather than silently dropped, and a
reopen that also carried a field edit is refused for the same reason. Only a
`human_user` actor may move a review to `ACCEPTED`, `CANCELLED` or `ARCHIVED`;
the three statuses an `agent_session` can reach are `ASSIGNED`, `IN_PROGRESS`
and `AWAITING_HUMAN_REVIEW`, and every other request is refused with
`AUTHORISATION_DENIED` and audited as `review.status_change_denied`.

`POST /api/v1/reviews/:reviewId/assign` names at most one of `assigned_user_id`
and `assigned_agent_session_id`; naming both is refused, and naming neither
clears the assignment. A `READY` review becomes `ASSIGNED`. Assignment is
separate from `review.claimed` because a human directing work and a worker taking
it are different facts.

`POST /api/v1/reviews/:reviewId/comments` appends a comment to the review itself
and answers `201`. It carries no author: attribution is derived from the
authenticated actor (`docs/DOMAIN_MODEL.md` section 18). `GET` returns the
current revision of each comment; `?revisions=all` returns the retained history.
`PATCH /api/v1/comments/:commentId` appends a new revision and supersedes the
previous one; only the author may edit, and only the current revision, which is
refused with `VERSION_CONFLICT` otherwise.

`GET /api/v1/reviews/:reviewId/export` queues a durable job that produces a
review-export artefact in the portable format of `docs/REVIEW_FORMAT.md`, and
answers `202` with the export's state. It changes state the first time it is
called, so it applies the CSRF rule of section 4.0 like any other write. Asking
again while a run is in flight joins that run rather than queueing a second one,
and answers `200` with the same export. When the job succeeds the export reports
`ready` with the artefact identifier, its digest and its size; an attempt that
fails leaves the export unready and no artefact at all. `reviewplane
export-review` writes the same document to a file or to standard output
(`docs/DEPLOYMENT.md` section 11).

The request and response bodies are the `review_create_request`,
`review_update_request`, `review_assign_request`, `review_transition_request`,
`comment_create_request`, `comment_update_request`, `review` and `comment`
schemas of `packages/protocol/schemas/review/v1.schema.json`, and the server
validates against the generated validator before any domain code runs.

## 13. Finding endpoints

```text
GET    /api/v1/reviews/:reviewId/findings
POST   /api/v1/reviews/:reviewId/findings
GET    /api/v1/findings/:findingId
PATCH  /api/v1/findings/:findingId
POST   /api/v1/findings/:findingId/claim
GET    /api/v1/findings/:findingId/comments
POST   /api/v1/findings/:findingId/comments
GET    /api/v1/findings/:findingId/verification
GET    /api/v1/findings/:findingId/verifications
POST   /api/v1/findings/:findingId/verifications
POST   /api/v1/findings/:findingId/accept
POST   /api/v1/findings/:findingId/reopen
POST   /api/v1/findings/:findingId/wont-fix
```

Updates include `expected_version`. A mismatch is refused with
`VERSION_CONFLICT` and the version the record actually holds, so a caller can
re-read and retry rather than guess. `POST .../claim` uses the same mechanism
rather than a separate one, so a human and an agent claiming at once produce one
claim and one `VERSION_CONFLICT`.

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

`GET /api/v1/findings/:findingId/verification` returns the most recent
verification submission for a finding, or `null`. The artefact viewer needs it:
the before-and-after comparison of `docs/UX_FLOWS.md` section 17 is the pair of
artefact identifiers it records (`docs/DOMAIN_MODEL.md` section 19), and a
finding with no submission yet is the honest empty state rather than a
comparison control with nothing to compare.

It resolves its scope through the same helper every other route in this section
uses, which carries the identifier, the session's project scope and **the
caller's own organisation** in one query, so a record that satisfies one term and
not the others is never returned. An earlier revision of this section recorded
that resolution as defective — a session of one organisation could read, and in
the `PATCH` cases modify, another's records — which RVP-66 and RVP-67 describe.
That defect is repaired: the organisation term is derived from the authenticated
principal rather than from the row being read, and a foreign identifier is
answered `RESOURCE_NOT_FOUND` byte for byte as an unknown one is.

The request body has **no `source` field**. It is derived from the authenticated
actor and is immutable thereafter (`docs/DOMAIN_MODEL.md` section 15); a body
that supplies one is refused as an unknown property by the generated validator,
before any handler runs.

Status transitions are checked in this order: version, **disposition
authority**, transition legality, remaining actor authority, completion
evidence.

Disposition authority comes before legality deliberately. An earlier draft of
this section put legality first, which contradicted the rule in the next
paragraph: a final disposition would then be `AUTHORISATION_DENIED` only from a
status the lifecycle already allowed it from, and `POLICY_DENIED` everywhere
else. That made the answer depend on where the finding happened to be — so an
agent asking to resolve a finding it had actually claimed was told the *move*
was impossible rather than that the *decision* was not its to make, and the
attempt was recorded under the wrong class. The rule is unconditional, so the
check that enforces it runs unconditionally.

- A finding cannot be set to `RESOLVED`, `WONT_FIX` or `DUPLICATE` by an agent —
  `AUTHORISATION_DENIED`, whoever authored the finding and **from any status**.
  For a human-authored finding that is the authority rule of
  `docs/DOMAIN_MODEL.md` section 15; for an agent's own it is the absence of any
  Stage 1 policy that would permit auto-resolution.
- Any other transition an agent requests outside the `docs/MCP_SPEC.md` section
  7.7 list is refused with `POLICY_DENIED` and `details.allowed_transitions`, so
  the refusal says what is possible from here rather than only what is not.
- A move to `FIXED_UNVERIFIED` without a resolution note is refused with
  `EVIDENCE_REQUIRED`.
- A move to `AWAITING_HUMAN_REVIEW` **by an agent** without a current
  verification carrying the project's configured evidence is refused with
  `EVIDENCE_REQUIRED` and `details.required_evidence` naming every gap
  (`docs/DOMAIN_MODEL.md` section 15, ADR-0029). The gate is not applied to a
  human actor, who is the authority it defers to.

**Every** refusal of a requested transition is audited as
`finding.status_change_denied`, written outside the transaction the refusal
rolled back — not only the authority ones. A refused transition is an attempt
whichever check refused it, and the event carries the stable code so its class is
readable without one event type per class. These are domain rules, enforced below the
transport, so they hold for the MCP surface as well as for this one — and an
agent credential presented to these routes is additionally refused at the
transport with `AUTHORISATION_DENIED`, by token shape, because the review API is
a human API (`docs/SECURITY.md` section 6.3).

`accept`, `reopen` and `wont-fix` are the human dispositions. `accept` moves the
finding to `RESOLVED`; `wont-fix` moves it to `WONT_FIX` and **requires a
reason**, or to `DUPLICATE` when it also names `duplicate_of_finding_id`, which
must be another finding of the same project; `reopen` moves it to `REOPENED` and
retains prior verification history. Each records `finding.resolved` or
`finding.reopened` beside `finding.status_changed`, naming the human who decided.

`POST /api/v1/findings/:findingId/comments` appends a comment and answers `201`;
`GET` returns the current revision of each, and `?revisions=all` the retained
history. Attribution is derived from the authenticated actor, and the request
body has no author field (`docs/DOMAIN_MODEL.md` section 18).

`POST /api/v1/findings/:findingId/verifications` submits a verification: a claim
with evidence, never a resolution (`docs/DOMAIN_MODEL.md` section 19). The body
carries `summary`, `branch`, `commit`, `tested_viewports`, `checks` and
`artefact_ids`, plus an optional `expected_version` that is compared **inside**
the transaction that writes the new version rather than by a read beforehand.

It has **no `submitted_by` and no `status`**, and their absence is the point: the
submitter is derived from the authenticated actor and the status is always
`submitted`, so a caller can neither forge an attribution nor record the human
decision that a verification was accepted. A body supplying either is refused as
an unknown property by the generated validator, before any handler runs. The
same server-side checks apply as on the MCP path — artefact ownership, project
scope, browser-session lineage, upload completeness, at least one screenshot,
and a commit differing from the one the finding was captured at — because both
surfaces reach one domain method. No workspace is resolved here, so the branch is
recorded uncorroborated rather than checked against something that is not there.

Accepting and rejecting a verification remain unimplemented; they arrive with the
review workspace UI, and the statuses those transitions target are the ones
above.

`GET /api/v1/findings/:findingId/verifications` returns every verification the
finding has accumulated, newest first, superseded records included. The
comparison UI needs the current one; anybody judging *whether the same thing has
been claimed before and failed* needs the rest, and a route serving only the
latest would make a repeatedly-reopened finding look like a first attempt every
time.

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

`PATCH` appends a revision and retains the one it supersedes; nothing is updated
in place. It carries `expected_revision`, and an edit against a revision another
writer has already superseded is refused with `VERSION_CONFLICT` rather than
applied over it, so two simultaneous edits produce one new revision and one
refusal instead of a forked history. The body has **no `type` and no
`artefact_id`**: changing either would make the retained revisions a history of
two different marks, and the honest way to move a mark to another shape or
another screenshot is to withdraw it and record a new one. Geometry is validated
against the annotation's own stored type rather than against one the request
named.

`DELETE` withdraws an annotation by recording a revision carrying `deleted_at`.
It is not a deletion: the current projection hides the mark and `?revisions=all`
still returns every revision it had, because a reader asking why a finding was
raised has to be able to see the mark that was on the screen when somebody
raised it — including one its author later thought better of. The expected
revision travels in the query string (`?expected_revision=`) rather than in a
body, because a `DELETE` with a body is not reliably carried by intermediaries.
Withdrawing an already-withdrawn annotation answers with the withdrawal rather
than refusing, and a withdrawn annotation cannot be edited back into existence.

Both routes emit `finding.annotated` with the new revision, so an edit and a
withdrawal leave the same kind of trail a creation does.

An annotation reached by its own identifier resolves through the same
three-term predicate every other record here does — the identifier, the
session's project scope and the session's organisation in one query — extended
with a join to the finding that owns it, because an annotation carries no review
column of its own. A foreign identifier and an unknown one produce the same
refusal byte for byte.

Neither `POST /api/v1/projects/:projectId/reviews` nor
`POST /api/v1/reviews/:reviewId/findings` requires an `Idempotency-Key`, and both
honour one. The capture flow of `docs/UX_FLOWS.md` §9 is why: a human presses
Save once, and a flaky connection or a double tap can make the control plane see
that press twice. There is no natural key to deduplicate a finding on — two
people may legitimately report the same problem — so the client names the
attempt. A replay answers `200` with the first response rather than `201`, so the
caller can tell it created nothing this time; the same key with a different body
is refused with `IDEMPOTENCY_CONFLICT`; and a refused attempt releases the key,
so a caller that fixed a slug collision may retry with it.

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

Step 2 returns `upload_path`, the proxied endpoint above, and `max_bytes`, the
largest body this deployment accepts. **Both drivers proxy the upload.**
ADR-0012 permits the `s3` driver to issue a presigned upload URL instead, and
this build does not: the server is where content-type validation happens, and a
presigned upload would put unvalidated bytes in the bucket before anything
looked at them. `upload_url` exists in the protocol for when that changes.

The bytes are sent as `application/octet-stream`, or as `image/png` or
`image/jpeg`. **The transport header is not the artefact's media type**: that
was declared on the intent and is verified against the bytes, so a DOM snapshot
and an accessibility snapshot travel as opaque bytes rather than as parsed
bodies whose re-serialisation would no longer match the declared digest.

Step 5 is the whole point of the flow: the server recomputes the digest of the
bytes it stored and compares it with both the declared and the observed value.
Until that succeeds the artefact stays `pending` or `uploaded`, no grant may be
minted for it — the attempt is refused with `ARTEFACT_UPLOAD_INCOMPLETE` — and
no caller may treat it as evidence.

**Two failures, two outcomes, two codes.** Bytes that do not match what was
declared are the uploader's fault: the artefact is marked `failed`,
`artefact.upload_failed` is recorded, the refusal is `409
ARTEFACT_UPLOAD_INCOMPLETE`, and the intent must not be retried, because it
describes something the uploader did not send. A store that cannot be written
to or read from is not the uploader's fault: the artefact keeps the state it
had, the refusal is `503 ARTEFACT_STORE_UNAVAILABLE` carrying `details.reason =
"artefact_store_unavailable"` and `details.retryable = true`, and the same
intent — and the same idempotency key — may be retried when the store returns.
Neither outcome makes anything available.

The second code is what a *reader* gets too: a verified artefact whose bytes
cannot be produced answers `ARTEFACT_STORE_UNAVAILABLE`, because that upload was
complete and saying otherwise would send an operator to look at an uploader that
did nothing wrong.

**No refusal names the store.** A filesystem error carries an absolute server
path and an S3 error carries the bucket endpoint and a fragment of the service's
own XML. Neither reaches a caller: `docs/SECURITY.md` section 18 requires a
stable code rather than free text precisely so that a failure is diagnosable
without a response carrying deployment data, and agent sessions and browser
workers both reach this path. The detail is written to the server log against
the same request identifier.

The intent honours `Idempotency-Key` (`docs/MCP_SPEC.md` section 10). A
repeated request with the same key and the same body replays the first intent
and returns `200`; the same key with a different body is refused with
`IDEMPOTENCY_CONFLICT`. A worker that crashed mid-upload and retried the whole
flow therefore produces one artefact rather than a second pending row for the
same capture.

Verification also decides what the bytes are and how large the picture in them
is. The declared media type is a claim; the bytes are evidence, and a mismatch —
an SVG uploaded as `image/png`, or a PNG uploaded as a DOM snapshot — is refused
on upload with `UNSUPPORTED_CAPABILITY` and marks the artefact `failed`. The
kind fixes which media types are accepted (`docs/SECURITY.md` section 13). For
an image the server measures the intrinsic pixel extent and records it as
`content_rectangle`, because that rectangle is the reference frame every
annotation on the artefact is normalised against (`docs/DOMAIN_MODEL.md`
section 16) and an uploader that could choose it could move every existing
mark. `filename` on the intent is display metadata only: it never reaches the
content-addressed storage key, and a value that is a path rather than a name is
refused.

`expires_at` is computed from the retention class at intent and stored. Nothing
deletes an artefact when it passes: retention enforcement is a later stage, and
the date says when removal becomes due rather than that anything happened.

Completing a `screenshot` enqueues a durable thumbnail job in the same
transaction as the availability transition. The thumbnail is a **separate**
artefact with its own digest, its own verification and `source_artefact_id`
pointing at the original, because ADR-0006 forbids rewriting an original to
carry something derived from it. `thumbnail_state` on the source records the
outcome — `pending`, `generated`, `unsupported` or `failed` — so a reader can
tell not-yet from not-possible.

### Reading metadata and deleting

`GET /api/v1/artefacts/:artefactId` resolves the artefact **inside the caller's
scope**: the identifier, the caller's project scope and the caller's
organisation are one predicate, so an artefact belonging to another project is
answered `RESOURCE_NOT_FOUND` byte for byte as an identifier that never existed
is. The same holds for minting a grant and for deleting.

`DELETE /api/v1/artefacts/:artefactId` retains the metadata row with
`deleted_at` set and removes the stored object **only when no other live
artefact shares its content-addressed key**. It records `artefact.deleted`,
whose payload says whether the bytes were removed. An optional
`X-ReviewPlane-Reason` header is recorded with the event. A cookie-authenticated
caller must carry the CSRF token, as it must for every state-changing route
(section 4.0).

**Only a human may delete.** An agent credential may read evidence and a
browser-worker credential may write it; neither may remove it, and both are
refused with `AUTHORISATION_DENIED`. That is the same authority boundary the
finding lifecycle draws: a machine principal adds to the record and does not
close it.

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
  "expires_in_seconds": 120,
  "disposition": "inline"
}
```

Under the `s3` driver `url` is a short-lived presigned URL at the storage
origin instead of a path this server serves (ADR-0012, ADR-0019). The grant row
is still written and `artefact.access_granted` still recorded, so the audit
trail does not depend on which driver a deployment runs, and the presigned URL
pins the content type and the disposition inside its signature.

`disposition` is derived from the media type and is never a caller's choice.
`attachment` means the bytes are active markup and are served as a download,
never rendered under the control-plane origin (`docs/SECURITY.md` section 13).

`GET /api/v1/artefact-content/:grantId` resolves the grant, authenticates the
caller independently, and requires the caller to be the grant's subject. The
grant identifier therefore travels safely in a URL — which is what an `<img>`
element needs — while the credential stays in the cookie or the `Authorization`
header, as `docs/SECURITY.md` section 18 requires. Minting a grant records
`artefact.access_granted`.

**Every refusal from this route is the same refusal.** An unknown grant, an
expired one, a revoked one, a caller with no credential and a live grant
presented by another principal all produce `401 AUTHENTICATION_REQUIRED` with
one message. Telling them apart is an existence oracle over grant identifiers,
which section 5 and `docs/TESTING.md` section 10 forbid; that the identifier is
24 random bytes makes such an oracle expensive rather than absent. It costs a
caller nothing, because the remedy is the same in every case: mint a new grant.

An earlier revision of this document specified `AUTHORISATION_DENIED` for the
wrong-principal case. That distinction was the oracle, and it is gone.

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

These are the **human** half of the inbox. An agent reads and acknowledges its
own items through `agent_inbox_list` and `agent_inbox_acknowledge` on
`/mcp/v1`; both surfaces call one store, so "acknowledgement is not completion"
(`docs/DOMAIN_MODEL.md` §21) has one implementation and two callers.

`GET` accepts repeated `status` parameters from `pending`, `acknowledged`,
`completed`, `dismissed` and `expired`, defaulting to the first two, plus the
`cursor` and `limit` of §6. It returns items **oldest first**, so assignment
order is preserved, and `meta.pending_count` beside the page. It writes nothing:
retrieval is idempotent, which §21 requires and which a method that issues no
`UPDATE` is the strongest form of.

The three `POST` routes change state and therefore require the session's CSRF
token (§4.0), checked before the body is decoded and before the record is
looked up. Completing or dismissing delivered feedback is the quietest way to
make a review disappear, so a request another origin caused must not reach it.

An **agent credential is refused on all four**, by actor type and before any
lookup, exactly as it is on the review routes: `docs/SECURITY.md` §6.3 says an
agent token must not reach administrative APIs, and an inbox is where work is
directed. A browser-worker credential is refused the same way.

`POST /api/v1/inbox/:itemId/complete` is the **only** way an item reaches
`completed`. There is no agent tool that can, which is what makes the rule
structural rather than conditional.

An item of another project answers exactly as an unknown identifier does: the
identifier, the session's project scope and the session's organisation travel in
one query, so the pair is not an existence oracle (§5).

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

Authorisation applies **both** the organisation and the project term of the
viewer's scope, against the browser session's own organisation and project, and
not one of them. A viewer session that names an organisation but no project list
is not narrowed by the project term at all — a null project list means "not
narrowed to a list", never "narrowed to nothing" — so the organisation
comparison is the only boundary left for it, exactly as it is on the event
channel of section 18.1. A viewer whose organisation differs from the session's
is refused with `PROJECT_CONTEXT_MISMATCH`.

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

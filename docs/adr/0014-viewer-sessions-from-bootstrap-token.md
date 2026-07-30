# ADR-0014: Exchange the bootstrap administrator token for a scoped viewer session

- Status: Accepted
- Date: 2026-07-30

## Context

The live-frame channel of `docs/API.md` section 18.2 is a WebSocket, and
`docs/SECURITY.md` section 7 requires every request to be authorised against
actor, organisation, project and resource before it is served. Stage 0 has one
human credential: the bootstrap administrator token of
`docs/ARCHITECTURE.md` section 11.

Three constraints meet here and rule out the obvious approaches.

1. A browser cannot set an `Authorization` header on a WebSocket handshake.
2. `docs/SECURITY.md` section 18 forbids credentials in logs, and a token in a
   query string lands in every access log, referrer and browser history entry
   on the path.
3. The bootstrap token is long-lived and administrative. Handing it to a page
   for the page to replay on each connection puts the deployment's strongest
   credential in `localStorage`, where any script that ever runs on the origin
   can read it.

`docs/API.md` section 4 already specifies the answer for the human API — "secure
session cookie for web UI" — but nothing said how a Stage 0 deployment with no
user accounts obtains one, and the live channel cannot be built without
deciding.

A second question arrives with it. "A viewer from another project is refused"
is a required behaviour and a required test, but Stage 0 has no memberships, so
there is no obvious actor that is scoped to a project rather than to everything.

## Decision

The bootstrap administrator token is exchanged, over an ordinary authenticated
HTTP request, for a short-lived **viewer session**.

1. `POST /api/v1/auth/viewer-sessions` accepts the bootstrap token in an
   `Authorization` header and returns a `Set-Cookie` carrying an opaque session
   token: `HttpOnly`, `SameSite=Strict`, `Secure` where TLS terminates at the
   gateway, and a twelve-hour lifetime (`docs/CONFIGURATION.md` section 2,
   `authentication.session_ttl`).
2. The control plane stores only the SHA-256 digest of the session token. A
   copy of the `viewer_sessions` table is not a set of usable credentials.
3. A viewer session carries an explicit project scope. The administrator's is
   organisation-wide (`project_ids` is null); `POST
   /api/v1/projects/:projectId/viewer-sessions` mints one scoped to a single
   project and returns its token exactly once.
4. The live WebSocket authenticates from the cookie and authorises the browser
   session's project against that scope, before the upgrade completes. A
   refusal is an HTTP status on the handshake, so no WebSocket — and therefore
   no frame — ever exists for an unauthorised viewer.
5. The upgrade additionally checks `Origin` against a configured allow list
   (`REVIEWPLANE_ALLOWED_ORIGINS`). `SameSite=Strict` already stops another
   site sending the cookie; the origin check is the second line, because a
   WebSocket handshake is not subject to the same-origin policy the way an
   XMLHttpRequest is.
6. Reads that the web application needs — projects, browser sessions — accept
   either the bootstrap token or a viewer session, and apply the same project
   scope. Writes stay administrative: a viewer session cannot start, command or
   terminate a browser session.

## Consequences

### Positive

- The strongest credential in the deployment is presented once, over a header,
  and never reaches page-accessible storage.
- No credential appears in a URL, so `docs/SECURITY.md` section 18 holds
  without asking operators to configure log redaction.
- Project scoping is a real enforcement path today rather than a placeholder,
  so the cross-project refusal test exercises the mechanism a membership will
  use rather than a stub.
- Revocation exists from the start: a session row can be revoked, and the live
  channel refuses the next upgrade.

### Negative

- A second credential kind exists before real accounts do, with its own table
  and expiry.
- A viewer session is bearer-equivalent for its lifetime: an attacker who
  extracts the cookie has it until it expires or is revoked. Short lifetime and
  revocation bound the exposure; binding the session to a device is deferred
  with the rest of the identity work.
- Stage 0 has no CSRF token. Nothing a viewer session can reach is
  state-changing, and `SameSite=Strict` covers the cookie, but the moment a
  state-changing route accepts a viewer session, the CSRF protection
  `docs/API.md` section 4 requires has to arrive with it.

## Alternatives considered

- **The bootstrap token in a query parameter.** Rejected: it lands in logs,
  history and referrers, which `docs/SECURITY.md` section 18 forbids.
- **The token in a `Sec-WebSocket-Protocol` header.** It avoids the URL, but it
  still requires the page to hold the administrator token to send it, which is
  the exposure this decision exists to remove.
- **No authentication in Stage 0, added with real accounts.** Rejected by the
  issue's own acceptance criteria and by `docs/SECURITY.md` section 5: an
  unauthenticated live-frame channel exposes whatever is on screen to anyone
  who can reach the port.
- **Full local accounts now.** More than the stage needs, and it would make the
  first authentication implementation one written for a single user rather than
  one designed against the OIDC path of `docs/SECURITY.md` section 6.1.

## Follow-up

- Local accounts and OIDC replace the bootstrap exchange; the viewer-session
  record and its project scope are the part that survives.
- A CSRF token joins this design when the first state-changing route accepts a
  viewer session.

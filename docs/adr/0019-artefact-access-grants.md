# ADR-0019: Reach artefact content through subject-bound access grants

- Status: Accepted
- Date: 2026-07-30

## Context

ADR-0012 requires that the `filesystem` driver serve artefacts "through the
server with equivalent short-lived, scoped access tokens" to the presigned URLs
the `s3` driver may issue. `docs/SECURITY.md` section 13 repeats the
requirement: artefacts are served "through short-lived authorised URLs or an
authenticated proxy". Neither says how, and Stage 0 shipped the narrowest thing
that worked — `GET /api/v1/artefacts/:artefactId/content`, gated on the
administrator bootstrap token — with a comment recording that the signed-URL
work was still to come.

Two things now force the decision.

The review viewer displays original screenshots. A browser loads an image
through an `<img>` element, which sends a URL and a cookie and cannot send an
`Authorization` header. So the previous route is unusable by the surface that
most needs it, and the obvious repair — putting a bearer token in the query
string — is refused by `docs/SECURITY.md` section 18, which forbids raw
credentials in anything that reaches a log.

Screenshots are also the highest-value asset the product holds
(`docs/SECURITY.md` section 2), and `docs/SECURITY.md` section 16 requires
artefact access to be audited. A path addressed by artefact identifier makes
that awkward: the identifier is shared in events, in review exports and in MCP
responses, so it is not secret, and any read of it is indistinguishable from
any other.

## Decision

Artefact bytes are reachable only through an **access grant**.

- `POST /api/v1/artefacts/:artefactId/grants` mints one. The caller must
  authenticate and must be authorised for the project that owns the artefact.
  The response carries a grant identifier, the path that serves the bytes, and
  an expiry.
- `GET /api/v1/artefact-content/:grantId` is the only route that returns
  artefact content. It resolves the grant, then authenticates the caller
  independently, then requires the caller to be the grant's subject.
- A grant names exactly one artefact, exactly one subject and an expiry of two
  minutes. It is not transferable and not enumerable: the identifier is 24
  random bytes.
- **No route serves an artefact from its identifier.**
  `GET /api/v1/artefacts/:artefactId/content` is removed.
- Minting a grant records an `artefact.access_granted` event with the subject
  and the expiry.

The split is the point. The grant identifier travels in a URL, which is what an
`<img>` element can carry and what an access log will record. The credential
stays in the cookie or the `Authorization` header. Neither half admits anybody
on its own, so the identifier in the URL is not a credential and section 18
holds.

Under the `s3` driver the same API mints a presigned URL instead of a grant
path. Callers see one flow; the driver decides what the URL points at.

## Consequences

### Positive

- The web application can display evidence without a credential in a URL.
- Every read of an artefact has an audited, subject-attributed grant behind it.
- No guessable static path to artefact content exists, so a leaked artefact
  identifier — which appears in events, exports and MCP responses — grants
  nothing.
- The MCP layer of RVP-39 gets the mechanism it needs for free: an agent
  session mints a grant scoped to itself and fetches with its own credential.
- The `s3` driver's presigned URLs slot into the same call without changing any
  caller.

### Negative

- Reading an artefact is two round trips rather than one.
- A viewer that keeps a page open longer than the grant's life must re-mint;
  the web application refreshes the grant on a timer well inside the expiry.
- The grants table grows with every view and needs an expiry sweep, which
  Stage 0 does not yet run. Expired grants are refused on resolution, so the
  absence of a sweep is a storage matter and not a security one.

## Alternatives considered

- **Keep the bearer-gated content route.** Unusable from an `<img>`, and the
  bootstrap token is long-lived, which is the opposite of "short-lived".
- **Signed URL with an HMAC over the artefact identifier and an expiry.** No
  database row, but the signature *is* a credential in a URL, so section 18
  refuses it, and revoking one before its expiry is impossible.
- **Cookie-only authorisation on the existing content path.** Simplest, and it
  leaves a stable path per artefact that is reachable by anyone who obtains a
  session — no per-artefact scoping, and nothing to audit beyond the request
  log.
- **Serve artefacts from a separate origin.** Sound for active content and
  worth revisiting when the product stores HTML or SVG artefacts; it does not
  by itself solve authorisation, and Stage 0 stores neither.

## Follow-up

- A retention job that removes expired grants, with the artefact-expiry work of
  Stage 2.
- The `s3` driver returning a presigned URL from the same endpoint.
- A separate artefact origin if a later stage stores active content
  (`docs/SECURITY.md` section 13, `docs/UX_FLOWS.md` section 17).

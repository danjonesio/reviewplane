# ADR-0038: A withdrawal is a recorded instant the gateway keeps, and a control credential names the operations and organisations it may act for

- Status: Proposed
- Date: 2026-08-07

## Context

Two properties the documents claimed were properties of the code's restraint
rather than of the system. Both are in the tunnel gateway, which is where a
route capability is verified and where a revocation has to land to be a
revocation at all.

### The route's absence was standing in for the revocation

`docs/ARCHITECTURE.md` §7.3 says a capability "is revocable individually as well
as through its route", and `packages/protocol/connectorv1/capability.go` says
"revoking the route revokes every capability bound to it". The gateway
implemented the second half by deleting the route: with no route, a request for
its origin answered `PUBLISHED_SERVICE_UNAVAILABLE`, and every capability for it
was refused as a side effect.

`Registry.Revoke` did write a map entry under the route identifier, but nothing
read that key — `CapabilityRevoked` read `"cap:"+capabilityID` and only that. So
the revocation was the deletion, and the deletion is undone by a registration:

```text
publish → browse                                        → 200
DELETE /internal/v1/routes/svc_test_01                  → 200
browse                                                  → 404
re-PUT the same route id and alias                      → 200
browse with the original, already-revoked capability    → 200, and the page
```

Forbidding the re-registration is not available. `docs/DOMAIN_MODEL.md` §10
requires a route inside its lifetime to resume "under the same identifier" when
its connector reconnects, and `docs/CONNECTOR_PROTOCOL.md` §17 builds reconnect
reconciliation on that. Burning an identifier would break the product's own
outage behaviour to close a hole in its revocation.

The control plane was already right: it writes `route_capabilities.revoked_at`
and keeps it. The gateway holds no database connection and must not acquire one
— `docs/ARCHITECTURE.md` §4.6 and `docs/SECURITY.md` §3 put the most exposed
component outside the control plane's persistence boundary — so the record it
needs has to be its own.

### The control credential carried no authority to describe

The gateway's control API took one bearer token. Any holder could register a
route for any project, delete any connector, withdraw any capability, and
`GET /internal/v1/routes` returned **every route in the deployment, across every
organisation**, with no tenancy term anywhere in the request or the handler.

ADR-0021 says of the `mcp` process that it "holds no connector channel and
registers no route; it withdraws", and `docs/ARCHITECTURE.md` §4.4 says "the
tunnel credential is there for one operation". Both sentences described what the
code chose to do. Neither described what the credential permitted, and the
credential permitted everything. That matters more here than it would elsewhere:
`apps/mcp-server` is the agent-facing process, built deliberately without the
administrator bootstrap token (ADR-0020) and without the capability signing key
(ADR-0021), precisely so that a compromise there stays bounded — and it was
handed a token that could register routes into any organisation and enumerate
the deployment.

`docs/SECURITY.md` §9 spends its length narrowing the ways into a development
machine and requires reads to be scoped "in one predicate carrying the
identifier, the caller's organisation and the session's project scope". The
gateway's own surface was outside that rule.

## Decision

### A withdrawal is a recorded instant, and the record is the revocation

The gateway keeps a **withdrawal set** with two kinds of subject:

- **A capability subject** withdraws one credential by identity. This is the
  narrow case that already existed: one browser session's access ends while the
  route stays up for the others named on it.
- **A route subject** records the instant the route was revoked. A capability is
  refused if its signed `issued_at` is **at or before** that instant.

The gateway never sees a capability until it is presented, so it cannot
enumerate the ones a route had outstanding. What it can record is the moment,
and `issued_at` is inside the signed payload. "Issued at or before the
revocation" is therefore exactly "outstanding when the route was revoked",
computed rather than listed.

It is an instant and **not** a permanent ban on the identifier, so that §10's
resumption stays possible. A capability minted after the revocation is by
definition not one that revocation covered. The comparison is at-or-before
rather than strictly-before because both are Unix seconds and a second is wide
enough to hold both events; refusing is the only safe reading of a tie.

The three ways a route ends — an explicit revocation, a connector revocation and
expiry — all record a withdrawal, because all three are cases where the route
identifier can be registered again.

### The withdrawal set is written to a journal before it is acted on

The set is appended to a file, flushed, and reloaded when the gateway starts.
`REVIEWPLANE_TUNNEL_REVOCATION_JOURNAL_PATH` names it; Compose gives it a volume
(`docs/DEPLOYMENT.md` §5).

The ordering is the property, and it is the same ordering the control plane
already uses when it tells the gateway before marking its own record closed:
**write the withdrawal down, then remove the route.** Removing the route first
and failing to write would leave the gateway having forgotten a route it can be
told to carry again, with nothing remembering that its capabilities are dead.

A withdrawal that cannot be recorded is **refused**, not warned about. The
control API answers `503 INTERNAL_ERROR`, the route keeps carrying traffic, and
the caller may retry. A revocation reported as done but not made durable is a
closure a restart silently reopens, which is the shape of this whole defect.

Records are dropped when nothing they refuse can still be presented — the
record's own `not_after`, not its age. For a route that is the configured
maximum route lifetime measured from the revocation, and never less than the
route's remaining life. The obvious tighter bound, the route's own expiry, is
**wrong**: "a capability may not outlive its route" is the control plane's rule
at minting (`docs/ARCHITECTURE.md` §7.3) and the gateway does not verify it —
`VerifyCapability` checks the token's own expiry and nothing compares it with
the route's. A record pruned at the route's expiry would be dropped while an
over-long capability was still presentable.

The journal holds withdrawals and **nothing else**. It holds no route
registrations: routes are the control plane's to register, and a gateway that
restored them from its own file would carry traffic nobody had asked it to
carry.

### A control credential names its operations and its organisations

`REVIEWPLANE_TUNNEL_CONTROL_CREDENTIALS` is a set of named principals. Each
carries an identifier, a secret, a set of operations from a closed vocabulary,
and the organisations it may act for (`docs/CONFIGURATION.md` §4.1). There is no
single-token form; a setting that could express one unscoped credential in a
line would be used.

The operations are `route:register`, `route:read`, `route:revoke`,
`connector:revoke`, `capability:revoke` and `metrics:read`. Every route on the
control API names the operation it requires where it is mounted, so the
authority a call needs is readable beside the call rather than inferred from
what its handler happens to touch.

A route registration carries `organisation_id`. It is required. The gateway does
not resolve organisations and never infers one; it carries the value so that a
scoped credential can be held to it. Enumeration returns only routes the
credential's scope admits; a read or a revocation of a route outside the scope
answers as absent rather than refused, which is `docs/API.md` §5's rule that a
foreign identifier and an unknown one are indistinguishable.

The shipped deployment configures two credentials:

| Credential | Operations | Organisations |
|---|---|---|
| `api` | every operation | every organisation |
| `mcp` | `route:revoke`, `capability:revoke` | every organisation |

ADR-0021's sentence about the `mcp` process is now enforced: the gateway refuses
a registration presented with that credential, and refuses an enumeration.

### Every control action is attributed

The gateway emits a `tunnel.control_action` audit record for every call on the
control API — allowed, refused or failed — naming the credential, the operation,
the subject and the outcome. The secret never appears; the identifier always
does. While the surface took one shared token this record could not have
existed: every call would have named the same principal, and "which process
registered this route" would have had no answer.

## Consequences

### Positive

- Revoking a route revokes the capabilities it had outstanding, and registering
  the identifier again resurrects none of them. The gateway's own state now
  matches the `revoked_at` the control plane already records.
- A withdrawal survives the gateway process. `docs/ARCHITECTURE.md` §7.5's
  paragraph beginning "Individual revocation is best effort" is narrowed to what
  is still true, and RVP-99's dependency on this issue is discharged.
- The `mcp` process's authority is now stated where it is enforced. A compromise
  of the agent-facing process can withdraw routes and capabilities — a denial of
  service against publications, bounded and audited — and cannot register a
  route, enumerate the deployment, or read the gateway's metrics.
- An organisation-scoped credential becomes expressible, which is what a
  future multi-tenant control plane or a per-organisation operator tool needs.
  Nothing in Stage 1 ships one; the mechanism is proven by test rather than by
  deployment.
- The gateway's audit trail can say who.

### Negative

- The gateway now keeps durable local state. It is a small append-only file
  rather than a database connection, and `docs/ARCHITECTURE.md` §4.6's "the
  gateway holds no database connection" is unchanged, but it is state where
  there was none: a deployment must give the gateway writable storage, and a
  gateway that cannot write it does not start.
- **Capability revocation is not organisation-scoped.** `DELETE
  /internal/v1/capabilities/{id}` names a capability and nothing else, and a
  capability identifier carries no organisation the gateway can read without
  minting it into the token or adding a route to the path. It is gated on the
  `capability:revoke` operation and on nothing else. The exposure is bounded and
  is stated rather than implied: a holder of any credential carrying that
  operation can withdraw any capability whose identifier it can guess, which
  costs availability and never confidentiality.
- **Connector revocation is attributed through routes and not directly.** The
  gateway holds no connector directory. An organisation-scoped credential may
  end a connector only when every route the gateway currently holds for it is
  inside that scope, and a connector the gateway holds no route for is revocable
  only by a credential acting for every organisation. A deployment-wide
  credential — the only kind Stage 1 ships — is unaffected.
- Two more secret files, and a credential set an operator can misconfigure into
  something wider than intended. The gateway refuses the misconfigurations it can
  detect (no credential, no operation, an unknown operation, a short secret, two
  credentials sharing a name or a secret) and states each credential's authority
  in its startup log; it cannot detect a deliberately wide grant.
- The register request grew a required field, so the control plane and the
  gateway must be upgraded together. The corpus in
  `services/tunnel-gateway/testdata/gateway-api/` is now run by both sides
  rather than only by the TypeScript client, so a future divergence fails a
  build.

### Neutral, and worth stating rather than leaving to be discovered

- The gateway still does not verify that a capability's expiry is inside its
  route's. That bound is applied by the control plane at minting
  (`docs/ARCHITECTURE.md` §7.3) and the withdrawal retention above is written to
  survive its absence. Making the gateway enforce it is a separate change with
  its own compatibility question, and is not made here.
- The journal is not in a backup archive (ADR-0025) and does not need to be:
  every withdrawal it holds is also `route_capabilities.revoked_at`, and a
  restored installation republishes its routes under new identifiers.
- A revocation performed while the gateway is unreachable is still a revocation
  the gateway never hears about. That is unchanged, and it is the control
  plane's retry to own rather than the gateway's.

## Alternatives considered

- **Forbid registering a revoked route identifier.** The smallest change and the
  wrong one: `docs/DOMAIN_MODEL.md` §10 requires a route to resume under its own
  identifier after a connector reconnect, so this would trade a revocation hole
  for an outage-recovery hole.
- **Have the gateway read `route_capabilities` from PostgreSQL.** It would make
  the control plane's record the single source of truth, and it would give the
  most exposed component a connection into the control plane's persistence.
  `docs/SECURITY.md` §3 puts that boundary between them deliberately, and
  `docs/ARCHITECTURE.md` §4.6 states the consequence. Rejected on the boundary,
  not on the effort.
- **Carry the revoked capability identifiers in the registration.** The control
  plane knows them, so a registration could name what is dead for that route.
  It makes correctness depend on the caller sending the list — the caller being,
  in the exploit, whoever holds the token — and it grows without bound for a
  long-lived route. The recorded instant needs nothing from the caller.
- **A signed control token rather than a configured credential set.** It would
  let authority travel with the caller and be rotated centrally, at the cost of
  a second key custody problem in a component that already holds one shared
  symmetric key. Stage 0 runs one control plane and one gateway in one trust
  zone (`docs/ARCHITECTURE.md` §13); a configured set states the same authority
  in the place that enforces it. Revisit when a deployment runs gateways it does
  not also configure.
- **A token per operation, or a token per process, without organisation scope.**
  Both were the cheaper halves of this decision. A token per operation gives no
  attribution — two processes holding the register token are still one principal
  in the audit trail. A token per process gives attribution and leaves
  `GET /internal/v1/routes` returning every organisation's routes to either of
  them. The enumeration is the part of the defect that leaks, so the scope had to
  come with the rest.

## Follow-up

- RVP-99 covers ending a browser session revoking the capabilities it held. ADR-0037
  gave `revokeCapability` its first production caller; what RVP-99 still carries
  is the coverage of the paths that end a session, not the durability of the
  withdrawal.
- Moving the gateway control API's schema into `packages/protocol` when API
  schemas land there, at which point the corpus in
  `services/tunnel-gateway/testdata/gateway-api/` is generated rather than
  committed.

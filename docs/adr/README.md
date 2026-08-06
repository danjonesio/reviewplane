# Architecture Decision Records

ADRs record decisions that materially affect architecture, security, protocols or product boundaries.

## Status values

- Proposed
- Accepted
- Superseded
- Rejected
- Deprecated

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-central-browser-workers.md) | Use central browser workers | Accepted |
| [0002](0002-outbound-connectors.md) | Use outbound development connectors | Accepted |
| [0003](0003-mcp-agent-interface.md) | Use MCP as the initial agent interface | Accepted |
| [0004](0004-reviews-as-system-of-record.md) | Reviews are durable system-of-record objects | Accepted |
| [0005](0005-postgres-and-object-storage.md) | Use PostgreSQL and S3-compatible object storage | Accepted; storage portion superseded by 0012 |
| [0006](0006-separate-annotations.md) | Store annotations separately from original evidence | Accepted |
| [0007](0007-single-controller-lease.md) | Enforce one browser controller with epochs | Accepted |
| [0008](0008-compose-first.md) | Make Docker Compose first-class | Accepted |
| [0009](0009-live-frames-ephemeral.md) | Keep live frames ephemeral by default | Accepted |
| [0010](0010-browser-content-untrusted.md) | Treat browser content as untrusted | Accepted |
| [0011](0011-vite-react-spa.md) | Vite React SPA for the web application | Accepted |
| [0012](0012-pluggable-artefact-store.md) | Pluggable artefact store with filesystem default | Accepted |
| [0013](0013-generated-protocol-models.md) | Generate protocol models from one bounded JSON Schema source | Accepted |
| [0014](0014-connector-identity-x509.md) | Issue connector identities as X.509 client certificates from a control-plane CA | Accepted |
| [0015](0015-browser-worker-tunnel-trust.md) | Reach the tunnel gateway by resolver rule and public-key pin, not by DNS and a trusted CA | Accepted |
| [0016](0016-viewer-sessions-from-bootstrap-token.md) | Exchange the bootstrap administrator token for a scoped viewer session | Accepted |
| [0017](0017-tunnel-upgrade-streams.md) | Carry HTTP upgrades as a declared stream mode, and bound streams by idle window rather than a flat lifetime | Accepted |
| [0018](0018-reconnect-reconciliation.md) | Reconnect reconciliation is control-plane authoritative and fails closed | Accepted |
| [0019](0019-artefact-access-grants.md) | Reach artefact content through subject-bound access grants | Accepted |
| [0020](0020-remote-mcp-endpoint-and-agent-credentials.md) | Serve the agent interface as a remote authenticated MCP endpoint with scoped agent credentials | Accepted |
| [0021](0021-two-phase-route-publication.md) | Publish a development service in two phases, requested by any control-plane process and completed by the one holding the connector's channel | Accepted |
| [0022](0022-connector-workspace-observation.md) | Report workspace Git context as its own bounded message on the connector `events` channel | Accepted |
| [0023](0023-connector-issued-agent-credentials.md) | A connector exchanges its device identity for a short-lived, single-project agent credential | Accepted |
| [0024](0024-transition-tables-as-protocol-data.md) | The review and finding transition tables, with their authority column, are protocol data | Accepted |
| [0025](0025-backup-archive-format.md) | A backup archive is a self-describing row-level export the product writes and reads, streamed through the operator's shell | Accepted |
| [0026](0026-worker-assignment-restated-on-every-heartbeat.md) | A browser worker's project assignment is restated on every heartbeat, and a revocation ends the sessions it covered | Accepted |
| [0027](0027-browser-worker-liveness-is-a-state-and-a-query-term.md) | Browser-worker liveness is both a swept state and a term in every query that decides something | Accepted |
| [0028](0028-browser-command-authority-derived-not-claimed.md) | Browser-command authority is derived from the authenticated actor, and the whole authorisation matrix runs in the control plane | Accepted |
| [0029](0029-completion-gate-is-advisory-and-non-terminating.md) | The completion gate reports and never decides, and never terminates the agent | Accepted |
| [0030](0030-verification-supersession.md) | A second verification supersedes the first, and exactly one is current | Accepted |
| [0031](0031-agent-assertions-are-not-control-plane-verification.md) | Agent-asserted checks are recorded as assertions, never as control-plane verification | Accepted |
| [0032](0032-freehand-paths-and-per-type-geometry-versions.md) | A freehand annotation is a bounded list of normalised points, and geometry is versioned per annotation type | Accepted |
| [0033](0033-element-context-resolved-from-a-captured-snapshot.md) | Element context is resolved by arithmetic over a captured snapshot, never by asking the page | Accepted |
| [0034](0034-browser-workers-are-a-deployment-wide-shared-pool.md) | Browser workers are a deployment-wide shared pool, administered by the deployment administrator | Accepted |
| [0035](0035-a-human-decision-names-the-verification-it-decides.md) | A human decision names the verification it decides | Accepted |
| [0036](0036-a-reopen-states-why-and-the-statement-is-a-comment.md) | A reopen states why, and the statement is a comment | Accepted |

## Pending decisions

These decisions are known to be required but are not yet recorded. They were identified while filing the Stage 0 to Stage 4 backlog in Linear (team ReviewPlane, prefix `RVP`), and the list below was re-checked against every issue in that backlog on 2026-07-30 (RVP-58).

Each of these ADRs takes the next available number when it is written, and is written as its stage approaches rather than in advance. Each decision keeps its own context, alternatives and consequences; bundling them would produce a record that cannot be superseded cleanly later.

Deferral is deliberate and is currently safe: no Stage 0 or Stage 1 issue depends on any of these decisions. Every Stage 1 issue — RVP-9, RVP-12, RVP-15, RVP-20, RVP-24, RVP-30, RVP-33, RVP-37, RVP-41, RVP-45, RVP-49, RVP-53, RVP-55, RVP-56 and RVP-57 — cites accepted ADRs only, and RVP-12 leaves the `/api/v1/members*` routes reserved and unimplemented until Stage 3. The earliest pending decision is needed for Stage 2.

Entries are of two kinds:

- **Required** — the issue states that an ADR must be recorded before its work lands. Do not implement the referenced work before its ADR is accepted.
- **Conditional** — the issue requires an ADR only if the work takes the design path named in the "Kind" column, and the issue itself settles which path applies. Do not take that path before an ADR is accepted; the rest of that issue is not blocked.

| Topic | Needed before | Stage | Kind | Architecture-change category |
|---|---|---|---|---|
| OIDC as a human authentication mode | RVP-51 | 2 | Required | Authentication, trust boundary |
| Organisation membership as the sole source of role grants | RVP-2 | 3 | Required | Authentication and authorisation |
| Permission model and service-layer authorisation | RVP-4 | 3 | Required | Authorisation |
| Change to the finding transition table under concurrent editing | RVP-7 | 3 | Conditional — only if the transition table changes | Review and finding lifecycle |
| Project policy evaluation leaving the service layer | RVP-19 | 3 | Conditional — only if evaluation moves outside the service layer or gains a submitted-program form | Authorisation and policy boundary |
| Outbound review export to a third-party issue tracker | RVP-27 | 3 | Required | Trust boundary, third-party data flow |
| Approval gates as an authorisation precondition | RVP-26 | 4 | Required | Authorisation, new durable authority object |
| Policy as code | RVP-31 | 4 | Conditional — only if a third-party policy language or engine is adopted, or policy documents become the authoritative store | Operational dependency, persistence |
| Secrets boundary and external secret-provider trust | RVP-35 | 4 | Required | Secrets, trust boundary |
| Envelope encryption and external key custody | RVP-38 | 4 | Required | Encryption and key custody |
| SAML coexistence with OIDC and local accounts, the authoritative source of role assignment, and the break-glass path | RVP-42 | 4 | Required | Authentication |
| Legal hold making deletion conditional | RVP-44 | 4 | Required | Persistence and deletion model |
| Air-gapped deployment topology and bundle supply-chain trust model | RVP-47 | 4 | Required | Deployment topology, supply chain |
| Worker pools as an isolation boundary | RVP-50 | 4 | Conditional — only if pool membership becomes an organisation isolation boundary rather than a scheduling preference | Authorisation boundary |
| Per-session browser sandboxing without Docker-socket access | RVP-52 | 4 | Required | Browser execution trust boundary, deployment topology, privilege model |

Stage 5 candidates are governed separately: `docs/ROADMAP.md` §7 requires measured demand and an ADR for each of them, tracked in RVP-1.

**The largest gap:** no accepted ADR records how authority is granted to a person. The accepted set records authentication for machine identities (ADR-0014), for the single bootstrap administrator and the viewer sessions derived from its token (ADR-0016) and for agent credentials carrying scoped capabilities (ADR-0020), plus one resource-level authorisation mechanism for artefact content (ADR-0019). None of them settles roles, permissions or membership, and much of Stage 3 and Stage 4 depends on that model. Write the permission-model ADR (RVP-4) before Stage 3 work begins rather than alongside it: organisation membership, the audit interface, review assignment, project policies and the isolation test suite all resolve against it.

When one of these ADRs is written, add it to the index and remove its row from this table in the same change.

## Amendments required

- **ADR-0001** describes central browser workers with no segregation concept between organisations or projects. ADR-0034 settles the Stage 1 position — the pool is deployment-wide and a worker belongs to no organisation, so the assignment table is the only tenancy a worker has — and RVP-50 still requires ADR-0001 to be amended with the worker-pool model when pools are introduced. ADR-0034 does not close RVP-50's conditional row above: it records that pool membership is **not** an isolation boundary today, which is the condition under which that ADR is not yet needed.

## Unresolved document conflict

`docs/ROADMAP.md` §7 lists "full desktop-stream fallback" as a Stage 5 candidate, while `docs/ARCHITECTURE.md` §16 lists full desktop VNC streaming as deferred architecture. The two documents disagree. Resolve this in an ADR before promoting that candidate; do not treat either statement as settled in the meantime. Tracked in RVP-1.

## Template

```markdown
# ADR-NNNN: Title

- Status: Proposed
- Date: YYYY-MM-DD

## Context

## Decision

## Consequences

### Positive

### Negative

## Alternatives considered

## Follow-up
```

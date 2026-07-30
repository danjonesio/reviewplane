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
| [0017](0017-tunnel-upgrade-streams.md) | Carry HTTP upgrades as a declared stream mode, and bound streams by idle window rather than a flat lifetime | Accepted |

## Pending decisions

These decisions are known to be required but are not yet recorded. They were identified while filing the Stage 0 to Stage 4 backlog in Linear (team ReviewPlane, prefix `RVP`). Deferral is deliberate: none of them is required for Stage 0. Each takes the next available number when written.

Do not implement the referenced work before its ADR is accepted.

| Topic | Needed before | Architecture-change category |
|---|---|---|
| Permission model and service-layer authorisation | RVP-4 | Authorisation |
| Organisation membership as the sole source of role grants | RVP-2 | Authentication and authorisation |
| OIDC as a human authentication mode | RVP-51 | Authentication, trust boundary |
| SAML coexistence with OIDC and local accounts | RVP-42 | Authentication |
| Approval gates as an authorisation precondition | RVP-26 | Authorisation, new durable authority object |
| Policy as code, if an external engine or an authoritative policy store is adopted | RVP-31 | Operational dependency, persistence |
| Secrets boundary and external secret-provider trust | RVP-35 | Secrets, trust boundary |
| Legal hold making artefact deletion conditional | RVP-44 | Persistence and deletion model |
| Air-gapped bundle supply-chain trust model | RVP-47 | Deployment topology, supply chain |
| Worker pools as an isolation boundary | RVP-50 | Authorisation boundary |
| Per-session browser sandboxing without Docker-socket access | RVP-52 | Browser execution trust boundary, privilege model |

**The largest gap:** the accepted set records no decision on authentication or authorisation at all, while much of Stage 3 and Stage 4 depends on that model. Write the permission-model ADR before Stage 3 work begins rather than alongside it.

## Amendments required

- **ADR-0001** describes central browser workers with no tenant-segregation concept. It must be amended when worker pools are introduced (RVP-50).

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

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
| [0005](0005-postgres-and-object-storage.md) | Use PostgreSQL and S3-compatible object storage | Accepted |
| [0006](0006-separate-annotations.md) | Store annotations separately from original evidence | Accepted |
| [0007](0007-single-controller-lease.md) | Enforce one browser controller with epochs | Accepted |
| [0008](0008-compose-first.md) | Make Docker Compose first-class | Accepted |
| [0009](0009-live-frames-ephemeral.md) | Keep live frames ephemeral by default | Accepted |
| [0010](0010-browser-content-untrusted.md) | Treat browser content as untrusted | Accepted |

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

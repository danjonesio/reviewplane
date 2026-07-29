# ADR-0005: Use PostgreSQL and S3-compatible object storage

- Status: Accepted; object-storage portion superseded by [ADR-0012](0012-pluggable-artefact-store.md)
- Date: 2026-07-28

## Context

The system needs transactional domain state and potentially large screenshots, traces and recordings.

## Decision

Use PostgreSQL for authoritative metadata, events and durable jobs. Use S3-compatible object storage for large artefacts, with MinIO bundled for Compose deployments.

## Consequences

### Positive

- Strong transactions and mature operations
- Portable self-hosted storage
- Large artefacts separated from relational state
- External managed services can be used later

### Negative

- Two storage systems require coordinated backup
- Object integrity and retention need explicit workflows

## Alternatives considered

- Filesystem-only storage
- PostgreSQL large objects for everything
- Mandatory vendor object storage

# ADR-0008: Make Docker Compose the first-class deployment

- Status: Accepted
- Date: 2026-07-28

## Context

The initial audience needs a practical self-hosted installation. Kubernetes-first architecture would increase operational cost and reduce adoption.

## Decision

Ship versioned OCI images and a supported Docker Compose stack. Add external storage, remote workers, Helm and air-gapped bundles in that order.

## Consequences

### Positive

- Accessible personal and small-team deployment
- Clear service isolation
- Straightforward local development and support
- Preserves later orchestration path

### Negative

- Compose is primarily single-host
- Multi-host scheduling requires later worker registration or Kubernetes

## Alternatives considered

- Single monolithic binary
- Kubernetes only
- Docker Swarm
- Vendor-hosted control plane only

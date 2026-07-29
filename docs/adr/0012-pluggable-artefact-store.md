# ADR-0012: Pluggable artefact store with filesystem default

- Status: Accepted
- Date: 2026-07-29

## Context

ADR-0005 selected S3-compatible object storage for large artefacts, with MinIO bundled in Compose deployments. Two problems have emerged.

First, MinIO's community edition has drifted away from dependable self-hosting: management features have been stripped from the open build and the project's direction favours its commercial offering. Bundling it as the default contradicts the product's self-hosting guarantees.

Second, for the Stage 1 single-host installation a bundled object-storage service adds a container, credentials, a bucket bootstrap step and an extra failure mode solely to store files on a disk the control-plane server already owns. This conflicts with the design principles "build the personal deployment first" and "operational clarity is a feature", and with the precedent set by using PostgreSQL for events and jobs instead of adding a broker.

## Decision

Artefact storage is accessed only through an internal storage-driver interface owned by the control-plane server. Two drivers are supported:

- `filesystem` (default): artefacts stored in a single data-directory volume. Writes are atomic (temporary file plus rename). This is the bundled Compose default and requires no additional service.
- `s3`: any S3-compatible endpoint, typically customer-owned or external. Supports the existing external-storage deployment mode and later multi-node stages.

Rules that apply regardless of driver:

- Browser workers upload artefacts through the control-plane artefact API and hold no storage credentials.
- Artefact keys are content-addressed (derived from the content hash) and never contain user-entered names. This preserves immutability of originals and supports integrity verification.
- Application metadata in PostgreSQL remains authoritative for artefact availability; an artefact is available only after integrity verification.
- The `s3` driver MAY issue short-lived, scoped presigned URLs to offload transfer; the `filesystem` driver serves artefacts through the server with equivalent short-lived, scoped access tokens.

MinIO is no longer bundled. Operators who want a self-hosted S3 service alongside ReviewPlane may run one (Garage or SeaweedFS are the documented options) and configure the `s3` driver against it.

This ADR supersedes the object-storage portion of ADR-0005. The PostgreSQL portion of ADR-0005 is unchanged.

## Consequences

### Positive

- Default installation drops a container, a credential pair and a failure mode
- Backup of a single-host installation is a database dump plus one directory
- Simpler air-gapped installations
- No dependency on MinIO's licensing or feature direction
- Multi-node and Kubernetes stages retain a clean path through the `s3` driver

### Negative

- The server is the data path for artefact transfer under the filesystem driver; large trace and video transfers consume server bandwidth
- Multi-replica control-plane servers require the `s3` driver or a shared volume; the filesystem driver is documented as single-server (remote browser-worker nodes are unaffected because artefacts flow through the control-plane API)
- Two drivers must be tested; the driver interface needs conformance tests run against both

## Alternatives considered

- Keep MinIO bundled: rejected for licensing and feature-stripping risk
- Bundle Garage or SeaweedFS instead: viable but still pays the extra-service cost for single-host installs; retained as a documented operator option rather than a default
- Filesystem only: rejected; blocks customer-owned storage and multi-node scaling
- PostgreSQL large objects: rejected in ADR-0005; unchanged

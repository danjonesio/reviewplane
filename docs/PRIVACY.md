# Privacy Model

## 1. Product promise

> Code, browser sessions, screenshots, reviews and agent activity remain inside infrastructure controlled by the operator, except where the operator explicitly configures an external provider.

This promise must be reflected in architecture and defaults, not only marketing language.

## 2. Default data locations

| Data | Default location |
|---|---|
| Source code | Development environment |
| Git working tree | Development environment |
| Project and review metadata | Customer PostgreSQL |
| Screenshots and traces | Customer artefact store: local volume or customer S3-compatible storage |
| Browser execution | Customer browser-worker container |
| Connector identity | Customer development environment and control plane |
| Agent/model conversation | Agent client's configured provider path |

The control plane does not need repository contents to provide the core workflow.

## 3. External data flows

External flows are disabled or absent by default except the coding agent's own configured model provider.

Possible explicit flows:

- External model used for visual inspection
- OIDC identity provider
- External object storage
- External secret provider
- Issue tracker export
- Optional telemetry

The administrator must be able to identify which data leaves the installation and why.

## 4. Telemetry

- No mandatory usage telemetry
- No hidden analytics
- No external browser assets or tracking pixels
- Crash reporting opt-in
- Diagnostic bundles generated locally and reviewed before upload

## 5. Data minimisation

- Do not upload source files by default
- Do not persist live frames by default
- Do not persist request or response bodies by default
- Do not retain raw browser profiles unless explicitly enabled
- Store bounded text excerpts rather than full pages when sufficient
- Allow retention by artefact type

## 6. User controls

Administrators can:

- Disable traces and video
- Shorten artefact retention
- Disable external visual models
- Choose storage and encryption provider
- Export reviews
- Delete projects and associated artefacts
- Disable optional telemetry
- Revoke connectors and sessions

## 7. Model-provider boundary

Self-hosting the control plane does not automatically keep agent prompts local. The UI and documentation must clearly show the configured model path:

```text
Agent CLI -> configured model provider
```

The control plane should not proxy model traffic in the MVP. A later model gateway is a separate optional capability.

## 8. Review portability

Reviews can be exported in an open, versioned format. Export must preserve:

- Findings
- Comments
- Annotation geometry
- Evidence metadata
- Verification history
- Source-control context
- Stable hashes

This reduces lock-in and supports private archival.

## 9. Deletion

Deletion follows a two-stage model:

1. Logical deletion or archive
2. Confirmed object and metadata purge according to policy

Audit tombstones may remain without retaining deleted content.

## 10. Air-gapped direction

The architecture must support operation with:

- Local container registry
- Internal Git
- Local or approved model
- Internal artefact storage
- Internal identity provider
- No external runtime assets

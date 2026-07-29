# Roadmap

## 1. Roadmap principles

- Deliver complete vertical slices
- Prove network and browser assumptions before polishing
- Keep reviews central
- Delay enterprise features until the personal workflow is reliable
- Define exit criteria, not only feature lists

## 2. Stage 0: Technical proof

### Goal

Prove the difficult integration points with minimal UI.

### Scope

- Central Chromium worker
- Development VM connector
- Outbound private HTTP/WebSocket tunnel
- Agent MCP connection
- Browser navigation and snapshot
- Live browser frames in a basic web page
- Screenshot capture
- Structured annotation overlay
- Named review storage
- Review retrieval through MCP
- Verification screenshot submission

### Deliberate omissions

- Multi-user authentication
- Polished project management
- Advanced retention
- Human takeover
- Console/network UI
- Production packaging

### Exit criteria

- A dev server bound to loopback on a remote VM is usable by central Chromium
- Claude Code or another MCP client can retrieve `bugs-on-homepage`
- A screenshot annotation aligns after UI resize
- Agent submits an after screenshot associated with a finding
- No public inbound port is required on the development VM
- Protocol round trip survives connector reconnect

## 3. Stage 1: Single-user vertical slice

### Goal

A usable end-to-end personal product.

### Scope

- Docker Compose installation
- Local administrator account
- Multiple projects
- Connector enrolment
- Workspace and Git context
- Published development services
- Browser allocation
- Live session room
- Screenshot annotations
- Named reviews
- Findings and comments
- MCP review and finding tools
- Agent inbox polling
- Before-and-after verification
- Human accept and reopen
- Basic event timeline
- Backup and restore scripts

### Exit criteria

- Fresh installation from release artefacts in one documented flow
- User can complete the full primary product loop without database access or manual object-store work
- Human-authored finding cannot be accepted through agent credentials
- Browser control commands are project scoped
- Core end-to-end workflow is covered by automated tests
- Upgrade from previous stage data fixture succeeds

## 4. Stage 2: Reliable personal product

### Goal

Make the product dependable for daily use across several VMs and projects.

### Scope

- Multiple connectors and browser workers
- Human takeover and control lease
- Console and network evidence
- Trace capture
- Session and connector recovery
- Review staleness detection
- Retention policy
- Artefact redaction
- Storage usage reporting
- Signed connector and image releases
- Structured operational diagnostics
- Optional external PostgreSQL and S3
- OIDC authentication

### Exit criteria

- Connector and control-plane restart recovery tests pass
- Stale commands are consistently rejected
- Retention removes artefacts without corrupting review metadata
- Redaction policy is tested against common secret surfaces
- External storage deployment is documented and tested
- Two browser workers can register and receive sessions

## 5. Stage 3: Team collaboration

### Goal

Support small engineering teams with clear ownership and auditability.

### Scope

- Organisation memberships
- RBAC
- Review assignment and mentions
- Multiple concurrent reviewers
- Optimistic concurrency UI
- Audit log interface
- Project policies
- GitHub and Linear issue export
- Review templates
- Shared visual baselines, limited scope
- Notifications

### Exit criteria

- Cross-project and cross-organisation isolation test suite passes
- Concurrent review edits resolve without silent data loss
- Audit trail covers all privileged actions
- OIDC group or role mapping is documented
- Team can operate without shared administrator credentials

## 6. Stage 4: Governance and restricted environments

### Goal

Support regulated and high-control deployments.

### Scope

- Approval gates
- Secret provider integrations
- Policy as code
- SAML or enterprise SSO adapter
- External KMS and Vault integrations
- Compliance exports
- Air-gapped bundle
- Organisation retention controls
- Worker pools and labels
- Higher-isolation browser execution option

### Exit criteria

- Air-gapped install, upgrade, backup and restore are tested
- Secret injection can occur without value disclosure to agent or UI
- Policy decisions are auditable and deterministic
- Approval replay and bypass tests pass
- External key unavailability fails closed

## 7. Stage 5: Advanced automation

### Goal

Use the accumulated evidence and review model for higher-value automation.

### Candidate scope

- Automatic visual regression detection
- Baseline branches and release baselines
- Multi-agent builder and reviewer workflows
- Review branching
- Automated review routing
- Release-candidate review templates
- Cross-project quality analytics
- Managed agent-session adapters
- Full desktop-stream fallback

Each feature requires measured demand and an ADR.

## 8. Deferred features

Do not include in Stages 0 or 1:

- Kubernetes-first deployment
- Full VM desktop control
- Native mobile app
- Built-in model hosting
- General remote shell
- Generic multi-agent scheduler
- Automatic prompt injection into arbitrary terminals
- Broad CI/CD replacement
- Multi-browser matrix beyond Chromium
- Billing platform
- Marketplace

## 9. Workstreams

### Platform

Domain model, API, events, authentication, jobs and storage.

### Browser

Worker, Playwright, live frames, evidence, control lease and redaction.

### Connector

Enrolment, tunnel, workspace context, local MCP bridge and recovery.

### Agent integration

MCP tools, resources, capability negotiation and repository instructions.

### Product UI

Projects, live room, annotation, reviews, verification and operations.

### Security and operations

Isolation, packaging, backups, upgrades, metrics and incident readiness.

## 10. Stage planning template

Every stage plan must define:

- User outcome
- Included capabilities
- Explicit exclusions
- Protocol changes
- Migration requirements
- Security review
- Test strategy
- Operational requirements
- Exit criteria

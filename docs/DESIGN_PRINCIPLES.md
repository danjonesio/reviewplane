# Design Principles

These principles are normative. Product and engineering decisions should be evaluated against them.

## 1. Evidence over agent claims

The system must distinguish between:

- An agent saying work is complete
- A tool reporting a successful action
- Evidence that the expected application state exists
- A human accepting the result

For user-visible work, completion should include reproducible evidence such as screenshots, browser state, console checks, network checks and source-control context.

## 2. Human authority remains explicit

Humans may delegate work, but they remain authoritative for:

- Accepting human-authored findings
- Approving sensitive actions
- Taking browser control
- Changing retention and security policy
- Overriding or cancelling agent work

An agent may resolve, verify or request acceptance. It must not impersonate final human approval.

## 3. Reviews survive execution sessions

Browser sessions and agent CLI sessions are ephemeral. Reviews are durable.

A review must remain useful after:

- A browser is destroyed
- The agent process exits
- A connector reconnects
- The project branch changes
- Work is reassigned

## 4. Structured context before pixels alone

A screenshot is valuable but ambiguous. Capture structured context whenever available:

- URL
- Viewport and device-pixel ratio
- Scroll position
- DOM selector
- Accessibility role and name
- Element bounding box
- Browser and source-control state
- Console and network evidence

Pixels remain the visual source of truth. Structured context improves reproducibility and agent precision.

## 5. Keep originals immutable

Original evidence must not be overwritten.

- Store original screenshots separately from overlays
- Store annotations as structured data
- Store revisions as new records
- Preserve audit history
- Generate derived thumbnails or rendered previews without replacing originals

## 6. One browser controller at a time

Agent and human input must never race.

Each browser session uses:

- One active controller
- A lease with expiry
- A monotonically increasing control epoch
- Explicit takeover and hand-back events
- Rejection of commands with stale epochs

Observation and system capture may continue without owning interactive control.

## 7. Browser content is untrusted

Text from the target application, external websites, user-generated content and downloads must be treated as untrusted evidence.

The system must preserve a boundary between:

- Trusted human and project instructions
- Trusted control-plane policy
- Untrusted browser content

MCP responses should label browser-derived content as untrusted. Agents should not follow instructions discovered in page content unless the user's task explicitly requires interpreting that content.

## 8. Self-hosting is the default architecture

The product must operate without a vendor-managed control plane.

- Core services run in customer infrastructure
- Storage remains customer controlled
- Telemetry is optional and disabled by default
- No mandatory external CDN, analytics or font dependency
- Managed hosting may exist later without becoming a technical requirement

## 9. Privacy requires data-flow control

Self-hosting alone is insufficient. The system must make data flow visible and controllable.

- External model calls are explicit
- Secrets are scoped and redacted
- Artefact retention is configurable by type
- Data exports are portable
- Administrators can disable recordings or raw artefact persistence

## 10. Outbound connections reduce exposure

Development connectors and remote workers should initiate authenticated outbound connections to the control plane. Users should not need to expose development VM ports or browser-debugging endpoints publicly.

## 11. Separate control, data and execution planes

- The control plane stores policy and authoritative metadata
- Browser workers execute untrusted application content
- Connectors bridge development environments
- Object storage contains large artefacts

Compromise of one component should not automatically provide unrestricted control over the others.

## 12. Agent-agnostic interfaces

The platform should support multiple agents through stable protocols rather than binding the domain model to a single vendor.

- MCP is the initial agent interface
- Agent capabilities are negotiated
- Reviews remain portable
- Adapter-specific features are optional enhancements

## 13. Safe failure over silent continuation

When security, control ownership, tunnel identity or required evidence is uncertain, stop or degrade safely.

Examples:

- Reject stale control commands
- Mark a review stale rather than pretending it is current
- Stop persistence when redaction fails under strict policy
- Require re-authentication after connector identity changes
- Keep a finding unresolved when evidence upload is incomplete

## 14. Build the personal deployment first

The initial installation should work well on one VM using Docker Compose. Do not impose Kubernetes, message-broker or service-mesh complexity before measured requirements justify it.

## 15. Vertical slices over broad scaffolding

Each stage should deliver a complete user workflow. Avoid implementing large disconnected subsystems that do not improve the review loop.

## 16. Operational clarity is a feature

Self-hosted administrators need clear:

- Health checks
- Logs
- Metrics
- Backup and restore procedures
- Upgrade compatibility
- Storage reporting
- Failure explanations

The product must explain what is broken and what action is safe.

## 17. Protocols are versioned products

Connector, MCP, event and API schemas require:

- Explicit versions
- Backwards compatibility policy
- Capability negotiation
- Clear error codes
- Contract tests

Do not coordinate distributed components through undocumented assumptions.

## 18. Minimise retained data

Live frames are ephemeral by default. Persist only what supports the review, audit, debugging or configured compliance requirement.

## 19. Accessibility is part of control

The human control plane and agent interaction surfaces should be keyboard accessible. The platform should capture accessibility-tree context because it improves both accessibility review and deterministic agent interaction.

## 20. No security by obscurity

Security controls must rely on authentication, authorisation, encryption, isolation and scoped capabilities, not hidden URLs or undocumented ports.

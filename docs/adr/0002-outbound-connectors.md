# ADR-0002: Use outbound development connectors

- Status: Accepted
- Date: 2026-07-28

## Context

Central browsers must reach applications bound to loopback on remote development VMs without requiring public ports or inbound firewall changes.

## Decision

Install a lightweight native connector that initiates authenticated outbound connections and publishes explicitly authorised local services through scoped, expiring routes.

## Consequences

### Positive

- No inbound development VM exposure
- Works behind NAT
- Supports workspace and Git context
- Provides local identity for MCP bridge

### Negative

- Requires installation and lifecycle management
- Introduces a security-sensitive tunnel protocol
- Connector compatibility must be maintained

## Alternatives considered

- Bind dev servers to LAN interfaces
- SSH reverse tunnels configured manually
- VPN mesh
- Playwright-only network exposure

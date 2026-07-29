# ADR-0001: Use central browser workers

- Status: Accepted
- Date: 2026-07-28

## Context

Coding agents run across development VMs. Installing and managing Chromium independently on each VM creates version drift, weak live visibility and duplicated resource management.

## Decision

Run Chromium in centrally managed browser-worker containers. Development applications remain on development environments and are reached through private connector routes.

## Consequences

### Positive

- Consistent browser and Playwright versions
- Central live viewing and evidence capture
- Independent browser scaling
- Simpler development VM requirements
- Agent-independent browser access

### Negative

- Requires secure routing to remote loopback services
- Central worker capacity becomes operationally important
- Browser origin behaviour requires careful tunnel design

## Alternatives considered

- Chromium on each development VM
- Human browser extension only
- Managed external browser service

## Follow-up

Implement connector tunnel proof before UI investment.

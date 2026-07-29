# ADR-0007: Enforce one browser controller using leases and epochs

- Status: Accepted
- Date: 2026-07-28

## Context

Agent and human input racing against each other can corrupt application state and make audit records meaningless.

## Decision

Every browser session has one active interactive controller. Control is granted through a time-bounded lease. Every transition increments a control epoch, and commands with stale epochs are rejected.

## Consequences

### Positive

- Deterministic control ownership
- Safe human takeover
- Replay protection
- Clear audit history

### Negative

- More state and reconnect handling
- Human disconnect behaviour requires policy

## Alternatives considered

- Last input wins
- Separate cursors with concurrent control
- Pause flag without epoch enforcement

# ADR-0010: Treat browser content as untrusted

- Status: Accepted
- Date: 2026-07-28

## Context

Applications and external pages can contain text designed to manipulate an AI agent or expose sensitive data.

## Decision

All browser-derived text, snapshots and artefacts are labelled untrusted. They cannot override human, project or control-plane instructions. Sensitive actions remain subject to policy and approval.

## Consequences

### Positive

- Clear prompt-injection boundary
- Safer agent behaviour
- Better audit semantics

### Negative

- Agent clients must preserve trust metadata
- Some workflows require explicit user instruction to act on page-provided requests

## Alternatives considered

- Trust project-owned pages
- Rely only on model prompt wording
- Strip all page text

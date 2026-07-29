# ADR-0004: Reviews are the durable system of record

- Status: Accepted
- Date: 2026-07-28

## Context

Browser and CLI sessions are ephemeral. Human feedback must survive session termination, reassignment and branch changes.

## Decision

Make the review the central durable domain object. Reviews contain findings, evidence, comments, source context, assignment and acceptance history.

## Consequences

### Positive

- Feedback survives sessions and agents
- Enables audit and before/after verification
- Creates a differentiated product object
- Supports future issue-tracker export

### Negative

- Requires lifecycle and concurrency design
- Staleness must be handled explicitly
- More durable storage than screenshot-only tools

## Alternatives considered

- Session-only chat messages
- Screenshot gallery with comments
- External issue tracker as sole system of record

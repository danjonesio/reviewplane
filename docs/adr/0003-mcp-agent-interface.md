# ADR-0003: Use MCP as the initial agent interface

- Status: Accepted
- Date: 2026-07-28

## Context

The product must support several coding-agent clients while exposing browser, review and verification capabilities.

## Decision

Use MCP as the initial agent-facing interface, with a local stdio bridge and optional remote authenticated endpoint. Keep the domain model independent of any one agent vendor.

## Consequences

### Positive

- Broad agent compatibility
- Discoverable tools and resources
- Structured context
- Supports named review retrieval

### Negative

- Client capabilities vary
- Managed push messages are not universally available
- Protocol compatibility must be actively tested

## Alternatives considered

- Vendor-specific plugins only
- Terminal text injection
- Plain REST API prompts

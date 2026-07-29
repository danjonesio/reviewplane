# ADR-0009: Keep live frames ephemeral by default

- Status: Accepted
- Date: 2026-07-28

## Context

Persisting every live frame creates high storage use and increases exposure of sensitive visual data.

## Decision

Stream live frames ephemerally. Persist action keyframes, findings, failures and configured recordings only.

## Consequences

### Positive

- Lower storage and privacy risk
- Review evidence remains focused
- Better default self-hosting footprint

### Negative

- Full historical video is unavailable unless enabled
- Some transient visual state may not be recoverable

## Alternatives considered

- Record every session by default
- Never permit video recording

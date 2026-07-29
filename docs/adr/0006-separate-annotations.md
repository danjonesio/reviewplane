# ADR-0006: Store annotations separately from original evidence

- Status: Accepted
- Date: 2026-07-28

## Context

Baking circles and comments into screenshots destroys the clean original and makes annotations difficult to edit, query or render responsively.

## Decision

Store immutable original screenshots and structured annotation records separately. Use normalised coordinates and render overlays in the client or export pipeline.

## Consequences

### Positive

- Toggleable and editable overlays
- Machine-readable geometry
- Clean original evidence
- Responsive rendering
- Multiple annotations per artefact

### Negative

- Requires careful coordinate handling
- Export rendering is an additional process

## Alternatives considered

- Draw directly into PNG
- Store only DOM selectors
- Store only text comments

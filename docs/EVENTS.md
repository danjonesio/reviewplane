# Event Specification

## 1. Purpose

Events provide immutable audit history, session timelines, realtime updates and integration delivery. They complement current-state tables rather than requiring full event-sourced reconstruction.

## 2. Event envelope

```json
{
  "id": "evt_...",
  "schema_version": 1,
  "sequence": 812,
  "type": "finding.verification_submitted",
  "occurred_at": "2026-07-28T11:24:22.182Z",
  "recorded_at": "2026-07-28T11:24:22.193Z",
  "organisation_id": "org_...",
  "project_id": "prj_...",
  "actor": {
    "type": "agent_session",
    "id": "ags_...",
    "display": "Claude Code on dev-ai-03"
  },
  "correlation": {
    "request_id": "req_...",
    "causation_event_id": "evt_...",
    "browser_session_id": "brs_...",
    "review_id": "rev_...",
    "finding_id": "fin_..."
  },
  "payload": {}
}
```

## 3. Ordering

- `sequence` is monotonically increasing within a project event stream.
- Global ordering across projects is not guaranteed.
- Consumers use event ID for deduplication.
- Realtime reconnect resumes from last acknowledged project sequence.

## 4. Immutability

Events are append-only. Corrections are represented by new events. Sensitive payload fields may be cryptographically erased only under documented deletion policy, while retaining a tombstone audit event.

## 5. Actor types

- `human_user`
- `agent_session`
- `connector`
- `browser_worker`
- `system`
- `integration`

Actor identity must never be inferred only from display text.

## 6. Event naming

Format:

```text
<aggregate>.<past_tense_action>
```

Examples:

- `review.created`
- `finding.claimed`
- `browser.control_transferred`

Names are stable public integration contracts.

## 7. Core event catalogue

### Organisation and identity

- `organisation.created`
- `user.invited`
- `membership.role_changed`
- `authentication.login_succeeded`
- `authentication.login_failed`
- `session.revoked`

### Project

- `project.created`
- `project.updated`
- `project.repository_changed`
- `project.archived`

### Connector and environment

- `connector.enrolled`
- `connector.connected`
- `connector.degraded`
- `connector.disconnected`
- `connector.revoked`
- `workspace.observed`
- `workspace.head_changed`

### Published service

- `published_service.requested`
- `published_service.ready`
- `published_service.failed`
- `published_service.expired`
- `published_service.revoked`

### Agent session

- `agent_session.started`
- `agent_session.waiting`
- `agent_session.blocked`
- `agent_session.completed`
- `agent_session.failed`
- `agent_session.disconnected`

### Browser session

- `browser_session.requested`
- `browser_session.allocated`
- `browser_session.ready`
- `browser_session.navigated`
- `browser_session.paused`
- `browser_session.resumed`
- `browser_session.degraded`
- `browser_session.terminated`
- `browser_session.failed`

### Control

- `browser.control_requested`
- `browser.control_transferred`
- `browser.control_released`
- `browser.command_rejected`
- `browser.command_executed`
- `browser.live_view_started`
- `browser.live_view_stopped`

Do not emit every pointer movement as a durable event. High-frequency input may be sampled or summarised.

The live-view pair is per viewer attachment, not per frame. A frame is not an
event, and a payload here never carries frame content: `started` records the
mode, `stopped` records why the viewer left and how many frames it was sent and
had dropped. They exist because a human watching a browser session is an access
to the most sensitive data the product handles (`docs/SECURITY.md` section 14),
and `AGENTS.md` requires that to leave an audit record.

### Evidence

- `screenshot.captured`
- `artefact.upload_started`
- `artefact.upload_completed`
- `artefact.upload_failed`
- `artefact.redacted`
- `artefact.expired`
- `trace.finalised`

### Review

- `review.created`
- `review.named`
- `review.assigned`
- `review.claimed`
- `review.status_changed`
- `review.accepted`
- `review.reopened`
- `review.archived`

### Finding

- `finding.created`
- `finding.annotated`
- `finding.claimed`
- `finding.status_changed`
- `finding.comment_added`
- `finding.verification_submitted`
- `finding.verification_accepted`
- `finding.verification_rejected`
- `finding.resolved`
- `finding.reopened`

### Inbox

- `inbox_item.created`
- `inbox_item.acknowledged`
- `inbox_item.completed`
- `inbox_item.expired`

### Policy and approval

- `policy.created`
- `policy.updated`
- `policy.decision_recorded`
- `approval.requested`
- `approval.granted`
- `approval.rejected`
- `approval.expired`

### Secrets

- `secret.reference_created`
- `secret.injection_requested`
- `secret.injection_succeeded`
- `secret.injection_failed`

Never include secret values.

## 8. Payload rules

- Payloads are versioned through `schema_version`.
- Include stable IDs and state transitions.
- Avoid duplicating large artefact content.
- Exclude raw secrets and sensitive headers.
- Include reason codes for denial and failure.
- Include previous and new state for state changes where safe.

Example:

```json
{
  "previous_status": "in_progress",
  "new_status": "awaiting_human_review",
  "verification_id": "ver_...",
  "version": 8
}
```

## 9. Transactionality

When a domain command changes authoritative state and creates an event, both operations should commit in one database transaction.

External delivery occurs after commit through an outbox pattern.

## 10. Realtime delivery

WebSocket subscribers authorise by organisation and project. Clients provide last seen sequence.

Server response on gap:

- Replay retained events from sequence
- Or instruct client to refresh state when replay window is exceeded

## 11. Webhooks and integrations

Later outbound integrations consume events through a durable delivery table.

Requirements:

- Signed payloads
- Retry with backoff
- Delivery ID for deduplication
- Dead-letter state
- Per-destination event filters
- Secret rotation

## 12. Retention

Audit-event retention is organisation policy. Session-detail events may have shorter retention than security and review events.

Deletion must preserve required referential and audit tombstones.

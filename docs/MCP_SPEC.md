# MCP Interface Specification

## 1. Purpose

The MCP interface is the primary agent-facing contract. It exposes browser operations, durable reviews, findings, inbox items and verification workflows without coupling the domain model to one agent vendor.

This document defines product semantics. Transport details may evolve with the MCP ecosystem, but tool names, authorisation rules and response meanings require versioned compatibility.

## 2. Design goals

- Agent agnostic
- Project scoped
- Explicit trust labelling
- Bounded responses
- Idempotent state changes
- Clear error codes
- Durable named review retrieval
- Safe human-agent handoff
- Evidence-based completion

## 3. Connection modes

### 3.1 Local stdio bridge

Preferred initial mode for CLI agents.

```text
CLI agent
  -> local MCP bridge
  -> authenticated HTTPS connection
  -> control-plane MCP server
```

The bridge may be installed with the connector or separately. It obtains short-lived agent credentials from the local connector.

### 3.2 Remote HTTP endpoint

Used when an agent client supports authenticated remote MCP directly.

The endpoint must require scoped credentials and must not accept human browser cookies as agent authentication.

## 4. Session initialisation

The client provides:

```json
{
  "client": {
    "name": "claude-code",
    "version": "unknown"
  },
  "project_hint": "refresh-surplus",
  "workspace_hint": "/workspace/refresh-surplus",
  "capabilities": {
    "resources": true,
    "image_content": true,
    "managed_messages": false,
    "session_resume": true
  }
}
```

The server returns:

```json
{
  "agent_session_id": "ags_...",
  "project": {
    "id": "prj_...",
    "slug": "refresh-surplus"
  },
  "workspace": {
    "id": "wsp_...",
    "branch": "redesign",
    "head_commit": "ab91d34",
    "dirty": true
  },
  "capabilities": {
    "browser_live": true,
    "image_resources": true,
    "human_takeover": true,
    "review_inbox": true
  }
}
```

Ambiguous project association must fail with a resolvable error rather than guessing.

## 5. Common response envelope

Tools should return a stable envelope:

```json
{
  "ok": true,
  "request_id": "req_...",
  "data": {},
  "warnings": [],
  "trust": "trusted_control_plane"
}
```

Errors:

```json
{
  "ok": false,
  "request_id": "req_...",
  "error": {
    "code": "CONTROL_EPOCH_STALE",
    "message": "Browser control changed. Refresh session state before retrying.",
    "retryable": true,
    "details": {
      "current_epoch": 28
    }
  }
}
```

## 6. Trust labels

Every response containing external or page-derived data must declare trust.

Values:

- `trusted_control_plane`
- `trusted_human_instruction`
- `trusted_project_configuration`
- `untrusted_browser_content`
- `untrusted_uploaded_artefact`
- `mixed`

Page content must never be returned without an untrusted label.

## 7. Tool catalogue

## 7.1 Project and session tools

### `project_current`

Returns the current project, workspace, branch, commit and policy summary.

Use when:

- Starting a task
- Validating a named review belongs to the current project
- Rechecking source state before verification

### `agent_session_status`

Returns agent-session identity, capabilities, associated browser sessions and pending inbox count.

### `agent_inbox_list`

Input:

```json
{
  "status": ["pending", "acknowledged"],
  "limit": 20
}
```

Returns project-scoped inbox items. Results are ordered oldest-first by default to preserve assignment order.

### `agent_inbox_acknowledge`

Acknowledges receipt. This does not complete the underlying work.

Input requires `inbox_item_id` and an idempotency key.

## 7.2 Published-service tools

### `development_services_list`

Returns connector-published services available to the current project.

### `development_service_publish`

Requests publication of a local service through the connector.

Input:

```json
{
  "workspace_id": "wsp_...",
  "local_host": "127.0.0.1",
  "local_port": 4321,
  "protocol": "http",
  "ttl_seconds": 3600
}
```

The server validates project policy and connector capability.

### `development_service_unpublish`

Revokes a published route immediately.

## 7.3 Browser lifecycle tools

### `browser_session_start`

Starts or reuses a browser session.

Input:

```json
{
  "published_service_id": "svc_...",
  "viewport": {
    "width": 1440,
    "height": 900,
    "device_scale_factor": 1
  },
  "recording": {
    "trace": true,
    "video": false
  }
}
```

Output includes browser session ID, control epoch, current controller and live-view availability.

### `browser_session_status`

Returns lifecycle, URL, pages, viewport, controller, epoch and policy state.

### `browser_session_pause`

Pauses agent-issued interactive commands. Non-interactive system capture may continue.

### `browser_session_resume`

Resumes when the agent owns or regains control.

### `browser_session_end`

Terminates the browser context and finalises configured traces.

## 7.4 Browser interaction tools

All interactive tools require:

- `browser_session_id`
- `control_epoch`

### `browser_navigate`

Input:

```json
{
  "browser_session_id": "brs_...",
  "control_epoch": 12,
  "url": "/checkout",
  "wait_until": "domcontentloaded"
}
```

Relative URLs resolve against the published service origin.

### `browser_snapshot`

Returns a bounded accessibility-oriented snapshot with stable references for the current snapshot only.

Example:

```text
- banner
  - link "Refresh Surplus" [ref=e2]
  - navigation "Main" [ref=e4]
- main
  - heading "Give technology another life" [ref=e9]
  - link "Browse products" [ref=e12]
```

Response trust is `untrusted_browser_content`.

### `browser_click`

Uses an element reference from a recent snapshot or an explicit selector where policy permits.

### `browser_type`

Types into a target. Secret values must not be supplied through this tool. Use secret injection tools.

### `browser_select_option`

### `browser_press_key`

### `browser_scroll`

### `browser_resize`

Resizing must produce a new snapshot and invalidate element references.

### `browser_wait`

Waits for a bounded condition, not an unbounded sleep.

Supported conditions:

- URL pattern
- Selector state
- Text state
- Network idle with maximum duration
- Custom bounded timeout

### `browser_take_screenshot`

Captures and optionally persists a screenshot.

Input:

```json
{
  "browser_session_id": "brs_...",
  "full_page": false,
  "persist": true,
  "purpose": "verification"
}
```

### `browser_console_messages`

Returns bounded console entries with sensitive values redacted.

### `browser_network_requests`

Returns bounded request metadata. Request and response bodies are excluded by default.

## 7.5 Visual inspection tools

### `visual_inspect`

Purpose:

Inspect the current application visually for layout, clipping, overlap, contrast, responsive and rendering problems. Use after frontend changes and before declaring a UI task complete.

Input:

```json
{
  "browser_session_id": "brs_...",
  "viewports": [
    {"width": 390, "height": 844},
    {"width": 1440, "height": 900}
  ],
  "checks": [
    "layout",
    "clipping",
    "contrast",
    "responsive",
    "console",
    "network"
  ],
  "create_findings": false
}
```

Output includes structured observations and screenshot resources. If a model-based visual analyser is configured, the data-flow policy must identify whether image content leaves the installation.

### `finding_create_from_observation`

Creates an agent-authored finding from visual inspection output.

Agent-authored findings must be labelled as such.

## 7.6 Review tools

### `review_list`

Filters by status, assignment, slug prefix or update time.

### `review_search`

Searches titles, slugs and finding text within the current project. Must not perform cross-project search.

### `review_get`

Input supports immutable ID or project-scoped slug:

```json
{
  "review": "bugs-on-homepage",
  "include": [
    "findings",
    "comments",
    "artefact_links",
    "staleness"
  ]
}
```

Returns branch, commit, findings, status and resource links. Large images are resources, not embedded indiscriminately.

### `review_claim`

Claims a review for the current agent session when allowed.

### `review_update_status`

Agents may request:

- `in_progress`
- `awaiting_human_review`
- `blocked`

Agents may not set a human-authored review to `accepted`.

### `review_add_comment`

Adds a clearly attributed agent comment.

## 7.7 Finding tools

### `finding_get`

Returns one finding, its evidence, annotation and latest verification.

### `finding_claim`

Claims one finding with optimistic concurrency.

Input includes expected version.

### `finding_update_status`

Allowed agent transitions:

- `open` -> `claimed`
- `claimed` -> `in_progress`
- `in_progress` -> `blocked`
- `in_progress` -> `fixed_unverified`
- `fixed_unverified` -> `awaiting_human_review`
- `reopened` -> `in_progress`

Human-only transitions remain unavailable.

### `finding_add_comment`

### `finding_submit_verification`

Input:

```json
{
  "finding_id": "fin_...",
  "summary": "Changed the navigation collapse breakpoint to 900px.",
  "branch": "redesign",
  "commit": "f27a191",
  "tested_viewports": [
    {"width": 768, "height": 1024},
    {"width": 820, "height": 1180},
    {"width": 900, "height": 900}
  ],
  "checks": {
    "reproduced_before": true,
    "console_errors_reviewed": true,
    "network_failures_reviewed": true
  },
  "artefact_ids": ["art_after_..."]
}
```

The server validates evidence ownership, commit context and required policy checks.

### `finding_mark_blocked`

Requires a reason and optional requested human action.

## 7.8 Completion tools

### `task_validation_status`

Returns project-policy requirements and missing evidence.

Example:

```json
{
  "browser_required": true,
  "requirements": {
    "required_viewports": ["390x844", "1440x900"],
    "console_review": true,
    "network_review": true,
    "final_screenshot": true
  },
  "missing": ["390x844 verification"]
}
```

### `task_complete`

The control plane evaluates completion policy.

It may return:

- `completed`
- `blocked_missing_evidence`
- `blocked_pending_review`
- `completed_with_warnings`

This tool does not terminate the CLI agent automatically. It records validation state and returns actionable requirements.

## 7.9 Secret tools

### `secret_list_references`

Returns names and permitted uses, never values.

### `secret_inject_browser`

Input:

```json
{
  "browser_session_id": "brs_...",
  "control_epoch": 12,
  "secret_reference": "secret://project/staging-admin-password",
  "target_ref": "e19"
}
```

Output confirms injection without returning the secret.

### `secret_inject_header`

Later capability, restricted by route and hostname policy.

## 8. Resources

Resources expose durable or large context.

### Review

```text
review://<project-id>/<review-id>
review://<project-slug>/<review-slug>
```

### Finding

```text
finding://<finding-id>
```

### Artefact

```text
artefact://<artefact-id>
```

### Screenshot

```text
screenshot://<artefact-id>
```

### Trace

```text
trace://<artefact-id>
```

Resources must enforce the same authorisation as tools.

## 9. Inbox workflow

Recommended agent checkpoints:

- Session start
- Before beginning a new task
- After completing a coding phase
- Before task completion
- After a human returns control

The server may signal that inbox items exist, but agents must explicitly retrieve and acknowledge them unless a managed agent adapter provides reliable message delivery.

## 10. Idempotency

State-changing tools require an `idempotency_key` when retries can occur.

The key is scoped to actor, tool and project. Reusing a key with different input returns `IDEMPOTENCY_CONFLICT`.

## 11. Concurrency

Review and finding updates use optimistic versioning.

Example:

```json
{
  "finding_id": "fin_...",
  "expected_version": 7,
  "status": "in_progress"
}
```

A mismatch returns `VERSION_CONFLICT` with current metadata.

## 12. Error codes

Initial stable codes:

- `AUTHENTICATION_REQUIRED`
- `AUTHORISATION_DENIED`
- `PROJECT_CONTEXT_AMBIGUOUS`
- `PROJECT_CONTEXT_MISMATCH`
- `RESOURCE_NOT_FOUND`
- `RESOURCE_STALE`
- `VERSION_CONFLICT`
- `IDEMPOTENCY_CONFLICT`
- `CONNECTOR_OFFLINE`
- `PUBLISHED_SERVICE_UNAVAILABLE`
- `BROWSER_CAPACITY_EXHAUSTED`
- `BROWSER_SESSION_NOT_ACTIVE`
- `CONTROL_NOT_OWNED`
- `CONTROL_EPOCH_STALE`
- `BROWSER_COMMAND_TIMEOUT`
- `POLICY_DENIED`
- `APPROVAL_REQUIRED`
- `EVIDENCE_REQUIRED`
- `ARTEFACT_UPLOAD_INCOMPLETE`
- `UNSUPPORTED_CAPABILITY`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

Adding a code is additive within a protocol version, and clients MUST tolerate a code they do not recognise. `BROWSER_COMMAND_TIMEOUT` reports a browser command that exceeded its declared bound; `docs/TESTING.md` section 11 requires that failure to be a stable code rather than an indefinite wait, and no existing code carried that meaning.

`RESOURCE_STALE` is the code for an element reference from a superseded snapshot and for a replayed command sequence. Acting on a stale reference MUST fail with it rather than target whatever now occupies that position.

`CONNECTOR_OFFLINE` covers a connector that is not connected and a connector that disappears mid-request: a request already in flight when the data channel drops MUST report it rather than a generic failure, and MUST NOT hang (`ARCHITECTURE.md` §14, `TESTING.md` §11). `PUBLISHED_SERVICE_UNAVAILABLE` is the code when the route itself is not one the deployment carries. The two are distinguishable on purpose: the first says come back, the second says publish again.

## 13. Bounded context

Tools must avoid returning unbounded page text, logs or histories.

- Use pagination
- Return summaries and resource links
- Apply per-tool size limits
- Exclude binary content unless explicitly requested
- Redact sensitive values

## 14. Versioning

The MCP interface has a product protocol version independent of application release version.

Clients and servers negotiate:

- Protocol version
- Tool availability
- Optional fields
- Resource content support

Breaking tool changes require a new major protocol version or a parallel tool name.

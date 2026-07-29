# Connector Protocol

## 1. Purpose

The connector links development environments to the control plane without exposing inbound management ports. It publishes selected local development services, reports bounded project context and provides local identity for agent sessions.

## 2. Non-goals

The connector is not:

- A remote shell
- A general VPN
- A filesystem synchronisation service
- A source-code uploader
- A general process-management agent
- An unrestricted proxy

Any future expansion into these areas requires an ADR and explicit security review.

## 3. Packaging

Preferred form:

- Statically linked Go binary
- systemd service on Linux
- Launch daemon or service equivalent on other platforms later
- Container option for advanced users

Default paths:

```text
/usr/local/bin/reviewplane-connector
/etc/reviewplane-connector/config.yaml
/var/lib/reviewplane-connector/
/var/log/reviewplane-connector/ or journald
```

## 4. Identity and enrolment

### 4.1 Enrolment token

Created by an administrator with:

- Organisation scope
- Optional project scope
- Expiry
- Maximum uses, default one
- Optional environment labels

### 4.2 Key generation

The connector generates a key pair locally. The private key never leaves the environment.

### 4.3 Registration request

```json
{
  "protocol_version": 1,
  "enrolment_token": "redacted",
  "public_key": "...",
  "environment": {
    "name": "dev-ai-03",
    "platform": "linux",
    "architecture": "amd64",
    "labels": ["proxmox", "development"]
  },
  "connector": {
    "version": "0.1.0",
    "capabilities": [
      "http-tunnel",
      "websocket-tunnel",
      "git-context",
      "local-mcp-bridge"
    ]
  }
}
```

The response provides connector ID, signed identity, control-plane endpoints and organisation policy digest.

## 5. Transport

Initial transport:

- Outbound TLS connection
- Mutual authentication after enrolment
- WebSocket-based control and multiplexed data streams
- Application-level stream identifiers
- Heartbeats and reconnect support

A future HTTP/2 or QUIC transport may replace the stream layer without changing published-service semantics.

## 6. Channels

Logical channels:

```text
control     commands, acknowledgements, policy and registration
heartbeat   health and capacity
routes      published-service lifecycle
data        multiplexed route traffic
events      local project and agent-session observations
upgrade     version and compatibility notices
```

## 7. Message envelope

```json
{
  "protocol_version": 1,
  "message_id": "msg_...",
  "type": "route.publish.ack",
  "sent_at": "2026-07-28T11:00:00Z",
  "connector_id": "con_...",
  "correlation_id": "cmd_...",
  "payload": {}
}
```

Messages must have bounded size. Large payloads are not transferred through the control channel.

## 8. Heartbeats

Default interval: configurable, approximately 15 seconds.

Payload:

```json
{
  "status": "healthy",
  "uptime_seconds": 8132,
  "version": "0.1.0",
  "active_routes": 2,
  "active_streams": 5,
  "resource_summary": {
    "load": 0.42,
    "memory_available_bytes": 8200000000
  }
}
```

Resource reporting is optional and should avoid sensitive process details.

State guidance:

- Missing a small number of heartbeats: delayed
- Exceeding disconnect threshold: disconnected
- Reconnection with valid identity: resume and reconcile

## 9. Workspace discovery

Discovery modes:

1. Explicit configured paths
2. Agent-session supplied working directory
3. Optional bounded root scanning

Default should be explicit paths or agent-supplied context. Broad filesystem scanning is disabled.

Reported data:

- Normalised repository remote identity
- Branch
- HEAD commit
- Dirty status
- Changed file paths where policy permits
- Workspace display label

Source file contents are not reported by default.

## 10. Development-service detection

The connector may detect listening development services through:

- Explicit agent request
- Configured command and port
- Process-owned listening socket correlation where permitted
- Framework output adapter later

Detection is advisory. Publication requires an explicit command or project policy.

## 11. Route publication

### Request from control plane

```json
{
  "route_id": "svc_...",
  "project_id": "prj_...",
  "workspace_id": "wsp_...",
  "local_host": "127.0.0.1",
  "local_port": 4321,
  "protocol": "http",
  "expires_at": "2026-07-28T12:00:00Z",
  "allowed_browser_session_ids": ["brs_..."]
}
```

### Connector validation

The connector must confirm:

- Project is authorised
- Workspace association is valid
- Local destination matches policy
- Port is listening or may become available within bounded startup grace
- Expiry is acceptable
- Concurrent-route limit is not exceeded

### Acknowledgement

```json
{
  "route_id": "svc_...",
  "status": "ready",
  "observed_destination": "127.0.0.1:4321"
}
```

## 12. Data stream protocol

Each tunnelled connection includes:

- Route ID
- Browser session ID
- Session capability
- Stream ID
- Destination protocol
- Deadline

The connector opens only the pre-authorised local destination. It does not accept a host or port supplied by the browser request.

Flow control must prevent one stream from exhausting connector memory.

## 13. WebSocket and hot-reload support

The route layer must preserve:

- HTTP upgrade
- Bidirectional frames
- Connection closure semantics
- Idle timeout suitable for hot reload
- Origin and forwarded headers according to configured mode

Header rewriting must be deterministic and documented.

## 14. Local MCP bridge

The connector may expose a local stdio command:

```bash
reviewplane-connector mcp
```

Responsibilities:

- Resolve local workspace and project
- Request short-lived agent-session credentials
- Proxy MCP traffic to the control plane
- Avoid storing long-lived agent tokens
- Surface connection and project errors clearly

It must not grant the agent connector-administrator privileges.

## 15. Agent-session association

Association methods, in priority order:

1. Local MCP bridge creates the session
2. Explicit CLI wrapper supplies process and workspace identity
3. User selects an active session in the UI
4. Heuristic process association, only as an optional degraded mode

The connector should not scrape terminal contents by default.

## 16. Local notifications

Supported initial notification:

```text
[ReviewPlane] New review assigned: bugs-on-homepage (3 findings, high priority)
```

Delivery may be through:

- Journald/log
- Desktop notification when available
- Optional terminal status file or shell hook

The connector must not inject text into an active terminal or pseudo-terminal in the initial release.

## 17. Reconnection and reconciliation

On reconnect, the connector sends:

- Connector version and capabilities
- Active local routes
- Active streams
- Known agent sessions
- Workspace head state

The control plane responds with authoritative desired state:

- Continue route
- Revoke route
- Re-establish session
- Upgrade required

Unknown or expired routes are closed.

## 18. Revocation

Revoking a connector:

- Invalidates its identity
- Closes control and data channels
- Revokes active routes
- Marks associated sessions disconnected
- Produces audit events

Re-enrolment creates a new connector identity.

## 19. Upgrades

The connector reports version and protocol range. The control plane classifies:

- Compatible
- Upgrade recommended
- Upgrade required
- Blocked as unsupported

Automatic self-update is deferred. Signed packages and explicit administrator action are preferred initially.

## 20. Configuration example

```yaml
control_plane:
  url: https://agents.example.internal

identity:
  data_dir: /var/lib/reviewplane-connector

workspaces:
  - path: /home/dan/projects/refresh-surplus
    project: refresh-surplus

publication:
  allowed_hosts:
    - 127.0.0.1
    - ::1
  allowed_ports:
    - 3000-3999
    - 4321
    - 5173
  max_routes: 10

privacy:
  report_changed_paths: true
  report_process_details: false
  discover_workspaces: false

logging:
  level: info
  format: json
```

## 21. Errors

Stable connector error classes:

- `ENROLMENT_TOKEN_INVALID`
- `IDENTITY_REVOKED`
- `PROTOCOL_UNSUPPORTED`
- `PROJECT_NOT_AUTHORISED`
- `WORKSPACE_NOT_FOUND`
- `DESTINATION_NOT_ALLOWED`
- `PORT_NOT_LISTENING`
- `ROUTE_LIMIT_EXCEEDED`
- `ROUTE_EXPIRED`
- `STREAM_LIMIT_EXCEEDED`
- `CONTROL_PLANE_UNAVAILABLE`
- `UPGRADE_REQUIRED`

## 22. Security requirements

See `SECURITY.md`. Protocol implementations require fuzzing, malformed-frame handling, bounded allocations, stream deadlines and negative authorisation tests.

# ADR-0039: The local MCP bridge is told where the agent endpoint is, rather than deriving it from the connector's own origin

- Status: Proposed
- Date: 2026-08-07

## Context

`docs/MCP_SPEC.md` §3.1 makes the local stdio bridge the preferred connection
mode for a CLI agent: `reviewplane-connector mcp` exchanges the environment's
X.509 device identity for a short-lived agent credential over the mutually
authenticated connector listener (ADR-0023), then proxies JSON-RPC to the §3.2
endpoint at `/mcp/v1`.

It found that endpoint by taking the connector's own control-plane URL and
replacing the path:

```go
endpoint, err := mcpbridge.MCPEndpoint(record.ControlPlaneURL, ...)
// parsed.Path = "/mcp/v1"
```

That is correct wherever one origin serves both, which is the deployment
`docs/CONNECTOR_PROTOCOL.md` §20 describes: `control_plane.url:
https://agents.example.internal`, with `/connector/v1/enrol` and `/mcp/v1` on
the same host.

**The shipped Docker Compose deployment is not that deployment.** ADR-0008 and
`docs/ARCHITECTURE.md` §4.1 put `/mcp` on the edge gateway, in front of a
separate `mcp` process on a separate route; the connector listener is a
different port on the control plane, terminating mutual TLS, serving
`/connector/v1/*` and nothing else. Deriving one origin from the other therefore
posts JSON-RPC at the connector listener, and the bridge dies on a 404 with a
valid credential in hand. Observed on the deployed stack while building the
end-to-end scenario of `docs/TESTING.md` §3 (RVP-95):

```text
local MCP bridge started ... credential agc_… for project fixture expiring …
{"message":"Route POST:/mcp/v1?project_hint=fixture&… not found",
 "error":"Not Found","statusCode":404}
local MCP bridge stopped
```

The credential exchange, the workspace resolution and the project binding all
worked. Only the address was wrong, and nothing in the connector's configuration
could say so.

## Decision

The connector configuration gains one optional key:

```yaml
control_plane:
  url: https://api.example.internal:8443   # enrolment, channel, credential exchange
  mcp_url: https://agents.example.internal # the §3.2 agent endpoint
```

- **Absent, the behaviour is unchanged**: the endpoint is derived from
  `control_plane.url` with the path replaced. A deployment where one origin
  serves both configures nothing and keeps working.
- **Present, it names the origin** the bridge posts to. The path, the
  `project_hint` and the `workspace_hint` are still built by the bridge; only
  the origin is taken from configuration.
- **`https` only.** `control_plane.url` accepts `wss` because the channel is a
  WebSocket; this endpoint is HTTP POST and never is, and the bridge sends the
  agent credential in an `Authorization` header on every message, so a
  plaintext value is refused rather than downgraded (`docs/SECURITY.md` §15).

The credential exchange is deliberately **not** moved. It stays derived from the
identity record's control URL, so the bridge cannot be pointed at a different
host than the connector's own channel: that would be a second trust anchor to
get wrong, and the exchange authenticates with a client certificate the listener
must terminate.

## Alternatives considered

**Route `/connector/v1/*` through the edge gateway**, so one origin serves
everything and no configuration is needed. Rejected: the control channel and the
credential exchange are mutually authenticated, and a proxy that terminated TLS
in front of them would have to reproduce the client-certificate verification
that is the whole of their authentication. It would also make the edge gateway
connector-facing, which is a trust-boundary change `docs/ARCHITECTURE.md` §4.1
deliberately avoids.

**Return the endpoint in the credential-exchange response.** Attractive — the
control plane knows where its own agent endpoint is — but it is a wire change to
a security-sensitive exchange, and the control plane's notion of its public
origin is a value an operator configures anyway. It also makes the endpoint a
runtime answer, so an operator debugging a bridge cannot read it out of a file.
It remains the better long-term shape if a deployment ever needs the endpoint to
move without touching development machines, and this decision does not close it
off: an absent `mcp_url` is exactly the place such an answer would land.

**Derive it from the enrolment response's `control_plane_endpoints`.** Those are
`wss` channel URLs on the connector listener, which is the origin this ADR
exists because the endpoint is *not* on.

## Consequences

- `deploy/compose/connector-config.yaml` sets `mcp_url` to the edge gateway, and
  the gateway joins the development network so a development machine can reach
  it — which is what a development machine does in any real deployment.
- The end-to-end scenario of `docs/TESTING.md` §3 can run steps 9 to 12 over the
  local bridge, which is the point: without this the bridge is unreachable in
  the deployment the product ships.
- One more setting an operator can get wrong. It fails loudly and immediately —
  the bridge exits with the endpoint in the message — rather than degrading.
- `docs/CONNECTOR_PROTOCOL.md` §20 and `docs/MCP_SPEC.md` §3.1 record the key.

## Not decided here

A bridge credential carries the workflow capabilities and no browser capability
(`docs/SECURITY.md` §6.3), while `finding_submit_verification` requires a
screenshot artefact. So an agent on the local bridge can retrieve, claim and
resolve a finding but cannot capture the after evidence its own hand-over
requires. That is a separate gap, recorded in `docs/TESTING.md` §3 where the
scenario has to work around it, and it needs its own decision.

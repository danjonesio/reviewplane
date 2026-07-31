# ADR-0023: A connector exchanges its device identity for a short-lived, single-project agent credential

- Status: Accepted
- Date: 2026-07-31

## Context

ADR-0003 named two connection forms for the agent interface, and ADR-0020 built
the second of them: a remote authenticated MCP endpoint reached with a bearer
agent credential that an **administrator** issues through
`POST /api/v1/organisations/:organisationId/agent-credentials`. That was the only
form Stage 0 could have, because Stage 0 had no connector.

`docs/MCP_SPEC.md` §3.1 makes the local stdio bridge the *preferred* form and
says the bridge "obtains short-lived agent credentials from the local
connector". `docs/CONNECTOR_PROTOCOL.md` §14 lists the same responsibility and
adds "avoid storing long-lived agent tokens". RVP-20 shipped the connector, its
X.509 device identity (ADR-0014) and the `reviewplane-connector mcp` command,
which resolves the workspace and then refuses because there is nowhere to obtain
a credential from.

So the question this ADR settles is where the credential comes from, and it is
an authentication-boundary question rather than a plumbing one. With only the
administrative route, a developer running a CLI agent has three bad options: ask
an administrator for a token every day, because the database constrains an agent
credential to at most 24 hours; keep one in a dotfile, which is the long-lived
token §14 forbids; or paste one into an MCP client configuration file, where it
is a credential in a URL or an environment variable that outlives the session.
Each of those is a worse outcome than the one this ADR chooses, and the third is
the one people actually do.

Two further things had to be decided with it.

The connector has exactly one authenticated channel today: a WebSocket control
channel over mutual TLS. Adding a message type to it would mean the bridge —
a **second process**, started per agent session — opening a second control
channel from one connector identity, which the heartbeat state machine of
`docs/CONNECTOR_PROTOCOL.md` §8 treats as one connection per connector.

And a connector is enrolled to an *environment*, which may host several
workspaces in several projects. A credential bound to everything the connector
can see would be wider than the session that asked for it.

## Decision

### The exchange is an HTTP request on the connector listener

`POST /connector/v1/agent-credentials`, served by the **connector listener** —
the separate Fastify instance that already terminates mutual TLS
(`apps/server/src/modules/connectors/index.ts`) — and authenticated by the
client certificate the connector presents, resolved to a connector record by
certificate fingerprint exactly as the control channel resolves it.

It is a request on that listener rather than a message on the control channel
because the bridge is a separate, per-session process and one connector holds
one control channel. It is on the connector listener rather than on the human
API because the credential it authenticates with is a device identity, and the
human API terminates no client certificates: keeping them apart is what makes "a
connector credential cannot become a human session" a property of the topology
(`docs/TESTING.md` §10).

The request names a **workspace**. The control plane resolves that workspace,
checks that it belongs to the connector's own environment, and issues a
credential bound to that workspace's project and to nothing else.

### The credential is narrow, short and unstored

- **One project.** The workspace decides it. A session opened with it therefore
  resolves unambiguously and can never meet `PROJECT_CONTEXT_AMBIGUOUS`.
- **One hour**, well inside the 24-hour maximum the `agent_credentials` table
  enforces. A bridge outlives its credential only if the agent works for more
  than an hour without reconnecting, and the endpoint re-resolves the credential
  on every request, so expiry stops the next call rather than letting a session
  run on.
- **The read and write capabilities of `docs/MCP_SPEC.md` §14.1 and nothing
  else.** The capability vocabulary contains no administrative capability, so
  "it must not grant the agent connector-administrator privileges"
  (`docs/CONNECTOR_PROTOCOL.md` §14) is true because there is no capability that
  could express it, not because a check removes one.
- **Never written to disk.** The token lives in the bridge process's memory for
  the life of the command. A connector restart ends the bridge; the next bridge
  requests a fresh credential. There is no file for a later reader to find and
  no code path that would read one.

Issuance records `agent_credential.issued` with the connector as actor, so the
audit trail distinguishes a credential a developer's machine minted for itself
from one an administrator granted.

### The administrative route stays

`POST /api/v1/organisations/:organisationId/agent-credentials` is unchanged. It
is how a remote MCP client that is not behind a connector is credentialed, and
how an operator issues a credential for a machine that has no device identity.
The connector route does not replace it; it removes the reason to misuse it.

## Consequences

### Positive

- The bridge of `docs/MCP_SPEC.md` §3.1 becomes implementable, and with it the
  Stage 1 exit criterion that a user can complete the product loop without
  database access or an administrator in the middle.
- The credential a CLI agent holds is narrower than the one an administrator
  would have issued: one project rather than the credential's whole binding, and
  one hour rather than a day.
- Nothing new is stored. The strongest form of "avoid storing long-lived agent
  tokens" is a code path that never writes one, which is what this is.
- The connector gains no new authority. It can mint a credential for a project
  it already carries traffic for, and for no other.

### Negative

- The connector binary makes its first outbound **HTTP** request. Until now it
  spoke only the WebSocket protocol of `docs/CONNECTOR_PROTOCOL.md`, and the
  guard test that forbids listening sockets in linked packages now has a client
  beside it. A client is not a listener and the guard still holds, but the
  binary's dependency surface grew.
- A compromised connector can mint agent credentials for its own projects for as
  long as its identity is valid. That is not a new capability in substance — a
  compromised connector already carries every byte of those projects' traffic —
  but it is a new shape, and revocation of the connector identity is what closes
  it (`docs/CONNECTOR_PROTOCOL.md` §18).
- Two issuance paths exist for one credential kind, so a change to the
  credential's shape has two callers to update. They share
  `AgentCredentialStore.issue`, so the shape itself has one definition.

## Alternatives considered

- **Add a `agent.credential.request` message to the connector control
  channel.** The natural home, and it does not fit: the bridge is a separate
  process started once per agent session, and the connector holds one control
  channel whose heartbeat state machine treats a second connection from one
  identity as a reconnection. The bridge would have to proxy through the running
  daemon over a local socket, which is a second local IPC surface on the
  development machine to secure — on the machine whose ports the product exists
  to keep unexposed.
- **Let the bridge use the administrative route with an operator token.** It
  would put an administrator credential on every developer's machine to obtain a
  weaker one, which is the wrong direction.
- **Give the connector a long-lived agent credential at enrolment and let the
  bridge reuse it.** Exactly what `docs/CONNECTOR_PROTOCOL.md` §14 forbids, and
  it would make the file the connector already stores its identity in a target
  worth stealing for reasons beyond the tunnel.
- **Bind the credential to every project the connector's environment can
  reach.** Simpler, and it would hand a bridge started in one checkout a
  credential for its neighbours. The workspace the agent is actually in is known
  at the moment of the request, so there is no reason to be wider than it.
- **Serve the exchange on the human API behind the bootstrap token.** It would
  require the human API to terminate client certificates, or the connector to
  hold a human credential. Both collapse a separation the deployment currently
  gets from having two listeners.

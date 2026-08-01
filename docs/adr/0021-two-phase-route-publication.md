# ADR-0021: Publish a development service in two phases, requested by any control-plane process and completed by the one holding the connector's channel

- Status: Accepted
- Date: 2026-07-31

## Context

`docs/MCP_SPEC.md` §7.2 gives an agent `development_service_publish`, and
`docs/PROJECT.md` §8 makes "publish a loopback development service" step three
of the MVP. `docs/CONNECTOR_PROTOCOL.md` §11 says what publication is: the
control plane sends `route.publish` down the connector's control channel, waits
for an acknowledgement naming the destination the connector observed, and only
then registers the route with the tunnel gateway.

That sequence has a hard constraint nobody had had to confront. **A connector
dials the control plane** (ADR-0002), so its control channel is an inbound
WebSocket terminating in the `api` process and held in that process's memory.
The agent-facing MCP endpoint is a **separate process and a separate image**
(ADR-0020), sharing the domain layer and the database and nothing else. It
cannot send `route.publish`, because there is no channel in it to send one on.

Three ways out were considered.

**Give the MCP process its own path to the connector.** Either a second inbound
listener that connectors also dial, or an internal HTTP route on `api` that the
MCP process calls with a new credential. Both add a network path into a
development machine and a credential that can be stolen, to solve a problem that
is one of process topology rather than of authority. `docs/SECURITY.md` §9
spends its whole length narrowing the ways into that machine; widening them here
would be the wrong trade for an implementation convenience.

**Give the MCP process the administrator token and let it call the public API.**
`apps/mcp-server/src/config.ts` refuses to read `REVIEWPLANE_BOOTSTRAP_TOKEN`
deliberately: "a process that cannot read one cannot leak one". Reversing that
for one tool would undo a property the agent surface was built with.

**Make the record the handoff.** The `requested` status already exists in
`docs/DOMAIN_MODEL.md` §10 and already means "asked for, not yet carrying
traffic", and reconnect reconciliation already treats a `requested` row as a
publication interrupted mid-flight (`docs/CONNECTOR_PROTOCOL.md` §17). Nothing
new has to be invented for a second process to leave a route in it.

## Decision

Publication is **two phases**, split at the point where a connector is needed.

**Phase one — request.** Any control-plane process may write a route as
`requested`. It runs everything the control plane can decide on its own: at
least one authorised browser session (§11), the lifetime bound, the destination
policy of `docs/SECURITY.md` §9 and the per-connector route limit. It writes the
row and `published_service.requested` in one transaction and touches nothing
outside PostgreSQL. **A refused destination therefore still never reaches a row,
an event, the connector or the gateway.**

**Phase two — complete.** The process holding the connector's control channel
sends `route.publish`, waits for the acknowledgement, registers the route with
the tunnel gateway and marks the record `ready`, or marks it `failed` carrying
the stable class from §21. `api` does this inline for its own HTTP callers, and
on a short interval for routes another process requested.

The sweep takes a route over only once it has been `requested` for longer than a
short grace, which is what keeps it from racing the inline path; `markReady` and
`markFailed` both refuse a record whose status has already moved, so the worst a
lost race costs is one wasted acknowledgement rather than two routes for one
request.

`development_service_publish` requests a route and then **waits, bounded**, for
it to leave `requested`. The wait ends in the record as it stands. A route still
`requested` when the deadline passes is reported as `requested` and never as
ready: an agent that navigated to an origin nothing was carrying would read the
failure as a fault in the application it is reviewing.

**Revocation is not split this way.** The tunnel gateway verifies a route
capability from its signature without a database read, so a record marked
revoked while the gateway still carried the route would be a revocation of
nothing. `development_service_unpublish` therefore reaches the gateway's control
listener directly, and the `mcp` service joins the `tunnel` network for that one
purpose. It holds no connector channel and registers no route; it withdraws.

**Minting stays where the key is.** `PublishedServiceConfig.capability` is
optional, and the MCP process is built without it. Minting binds a route to one
browser session and the control plane is the minting authority
(`docs/ARCHITECTURE.md` §7.3); a process that drives no browser session has no
reason to hold the signing key, and `mint` refuses rather than signing with a
placeholder.

## Consequences

- An agent's publication is not instantaneous. It costs at most one sweep
  interval on top of what the connector takes, and the connector's own startup
  grace is ten seconds (§11), so the sweep is not what dominates the wait.
- A route requested while nothing can complete it does not hang: the completion
  sweep reaches it, the connector exchange fails with `CONNECTOR_OFFLINE`, and
  the record becomes `failed` carrying that class. §11's "neither leaves a
  published service in `requested` for ever" holds for the MCP path as well as
  the HTTP one — and it holds even if no completion sweep runs at all, because
  the **expiry** sweep ends a route that reached its expiry in `requested` just
  as it ends a live one. That second path matters: without it, "nothing stays in
  `requested`" was a promise kept by a one-second timer rather than by the
  record's own lifetime, and a route nothing completed held a slot against the
  per-connector limit indefinitely.
- A deployment running several `api` replicas runs several sweeps. That is safe
  rather than merely tolerable, because the status guard is in the `UPDATE`.
- The `mcp` service reaches the tunnel gateway's control listener. That listener
  binds to loopback by default and to the internal `tunnel` network in Compose;
  it is not published, and the MCP process reaches nothing else on that network.
- `published_service.requested` may now be written by an `agent_session` actor.
  `docs/EVENTS.md` §5 already admits that actor type, and an auditor can tell an
  agent's publication from a human's by it.

## Alternatives rejected

- **A durable job.** The job runner is a third process (`docs/ARCHITECTURE.md`
  §4.8) and would have the same problem: it holds no channel either.
- **`LISTEN`/`NOTIFY` from the requesting process.** It removes the polling
  interval and adds a delivery path that is silently lost on reconnect, for a
  latency saving that is small beside the connector's startup grace. It can be
  added later without changing this decision, because the record remains the
  handoff.
- **Running the MCP endpoint inside `api`.** ADR-0020 separated them so that the
  agent surface has its own process, its own route and no administrator
  credential. Reversing that to make one tool simpler is the larger change.

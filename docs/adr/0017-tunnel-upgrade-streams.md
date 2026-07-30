# ADR-0017: Carry HTTP upgrades as a declared stream mode, and bound streams by idle window rather than a flat lifetime

- Status: Accepted
- Date: 2026-07-30

## Context

`docs/ARCHITECTURE.md` §7.4 lists WebSockets, HTTP streaming, server-sent events and development hot reload as mandatory tunnel capabilities. Stage 0 shipped none of them: the gateway refused every HTTP upgrade with `UNSUPPORTED_CAPABILITY`, and every stream carried a flat 60-second deadline.

Both gaps are correctness problems rather than missing conveniences.

- **Every development server the product's first users run needs a WebSocket.** Vite, Next.js in development mode, SvelteKit and Astro all deliver hot module replacement over one. If that upgrade fails, the page in central Chromium silently stops updating while still looking live. A human annotates a stale render and an agent verifies against one, so the failure produces false findings and false verifications — the exact outcome the review loop exists to prevent.
- **A 60-second stream lifetime is wrong for anything that streams.** A `text/event-stream` response, a chunked response and a WebSocket are all long-lived by design. A flat lifetime cuts them mid-work, and lengthening it uniformly would instead leave stalled request/response exchanges open far longer than they should be. One number cannot serve both.

Two properties make this a decision rather than an implementation detail, and therefore an ADR under `AGENTS.md` "Architecture changes":

- **Trust boundary.** An upgraded connection is a long-lived bidirectional channel from the browser zone into the development environment. Whether it can outlive the route that authorised it is a security decision, not a timeout.
- **Agent protocol.** The connector relays bytes without parsing them (`docs/CONNECTOR_PROTOCOL.md` §12), so it cannot see that a connection has been switched. If an upgraded stream is to be treated differently from an ordinary one, the difference has to be declared on the wire, and `packages/protocol` is the only place a wire field may be defined (ADR-0013).

## Decision

### 1. An upgrade is carried inside `http` and `https`, not as a new destination protocol

`route.publish` keeps `protocol` as `http` or `https`. There is no `websocket` value.

A route names a host and a port. A development server serves its documents and its hot-reload socket **on the same port**, so a route that declared itself "a WebSocket route" would either need a second route for the same port or would have to mean "this port, but only upgrades" — and neither is true of any real development server. Declaring the destination protocol as `websocket` would also imply the connector speaks WebSocket to the destination, which it does not: it opens a TCP socket and relays.

The schema has said this since Stage 0 — "HTTP upgrade to WebSocket is carried inside http and https" — and that reading is now load-bearing rather than aspirational.

### 2. The stream header declares a `stream_mode`

`data_stream_header` gains one optional property:

```json
"stream_mode": { "enum": ["request_response", "upgrade"] }
```

Absent means `request_response`. It is a closed set: a mode this version does not define is refused by the schema rather than treated as `request_response`, so a future framing cannot be silently downgraded into one the connector would relay on different terms.

`stream_mode` selects **the stream's idle window and nothing else**. It does not influence which destination is opened — that is fixed at publication, and the header still carries no host and no port — and it does not relax any check. An upgraded stream for an unpublished route, an expired route or an unauthorised browser session reaches nothing, exactly as an ordinary one does.

### 3. Only the `websocket` upgrade token is carried

`h2c` is refused because HTTP/2 is deferred by `docs/ARCHITECTURE.md` §7.4 and `docs/CONNECTOR_PROTOCOL.md` §5. Everything else is refused because relaying a framing the gateway has never seen is indistinguishable from being the raw TCP forwarder `docs/SECURITY.md` §9 excludes permanently. Refusals answer `UNSUPPORTED_CAPABILITY`.

An `Upgrade` header without a `Connection` token nominating it — or the reverse — is malformed rather than ambiguous, and is refused rather than guessed at. Requiring both halves also means a caller cannot change how a request is framed by adding a single header.

### 4. Stream lifetime is an idle window bounded by the route's expiry

The flat `stream_ttl` is replaced by three settings:

| Setting | Default | What it bounds |
|---|---|---|
| `stream_max_lifetime` | `8h` | absolute lifetime, and never beyond the route's expiry |
| `stream_idle_timeout` | `60s` | no progress on a request/response stream |
| `upgrade_idle_timeout` | `15m` | no progress on an upgraded stream |

The absolute lifetime is a backstop, not the working control: its default equals `route_ttl_max`, so in practice the route's own expiry is the bound. What ends an ordinary stream is the exchange finishing; what ends a stalled one is the idle timeout. What ends an upgraded one is either end closing it, its route ending, or fifteen minutes of complete silence.

Fifteen minutes is chosen against the failure it exists to prevent. A developer reading code sends nothing over the hot-reload socket, and neither Chromium nor any of the development servers above closes an idle one; a window shorter than a plausible reading pause would make the tunnel the thing that broke hot reload. It is configurable, so a deployment that measures differently can say so.

### 5. Route expiry and revocation close upgraded connections

`docs/ARCHITECTURE.md` §7.3 requires a route to be revocable immediately. An upgraded connection that survived its route's revocation would make that only a revocation of future requests, and a persistent WebSocket would become a way to hold access open indefinitely. So:

- every stream's absolute deadline is clipped to its route's expiry, upgraded or not;
- revoking or expiring a route resets its in-flight streams, including upgraded ones, and the browser sees the connection close;
- the gateway sets the same deadline on the hijacked client connection, so the connection cannot outlive the route even if every other control failed.

### 6. Backpressure is the existing flow-control window, applied unchanged

An upgraded connection is relayed with one bounded copy buffer per direction. Everything beyond that is the per-stream credit window of `docs/CONNECTOR_PROTOCOL.md` §12.2, which is returned only as bytes are consumed. A browser that stops reading therefore stops the development service rather than filling a queue in the tunnel, and a development service that floods stops itself. Nothing new was added for the upgraded case, which is the point: the same control covers both.

### 7. The connector sweeps its own streams

The gateway already enforced deadlines on a ticker; the connector did not. With streams that live for a review session, a data channel that died mid-stream would leave the developer's own machine holding open sockets nothing was going to end. The connector now runs the same sweep, and a terminated stream closes the local socket immediately rather than waiting for its absolute deadline.

## Consequences

### Positive

- Hot module replacement works through a route, which is what makes "the page in Chromium is the page the agent is changing" true rather than assumed.
- Server-sent events and chunked responses survive longer than a minute, so an application feature that streams can be reviewed at all.
- The lifetime model now says what it means: an idle window for liveness, the route for authorisation. Neither is doing the other's job.
- One long-lived connection cannot be used to outlive a revocation.

### Negative

- An upgraded connection occupies a stream for a review session, so `max_streams_per_route` is now also the bound on concurrent long-lived connections per route. The default of 64 is ample for development servers, which open one socket per page, but it is a bound an operator can now hit for a reason they did not have before.
- The gateway hijacks the client connection for an upgrade, so after the switch `net/http` enforces nothing on it and the relay owns every bound itself. That code is small and its bounds are explicit, but it is the one place in the request path where the standard library is no longer the backstop.
- `stream_ttl` is gone. It was never set in any shipped configuration, but a deployment that had set it must move to `stream_max_lifetime`, whose meaning is different.
- Both ends compute the idle window from the same declared mode but from their own configuration. In Stage 0 the connector uses the protocol defaults and only the gateway's windows are configurable, so tuning the gateway's window longer than 15 minutes leaves the connector's shorter one in force. The shorter of the two applies. Making the connector's windows configurable is follow-up work.

## Alternatives considered

- **A `websocket` destination protocol on `route.publish`.** Rejected in §1: a development server serves documents and its hot-reload socket on one port, so the declaration would be false for every real route.
- **Inferring the mode in the connector by parsing the relayed bytes.** Rejected outright. `docs/CONNECTOR_PROTOCOL.md` §12 forbids the connector from parsing relayed content, and ADR-0010 makes those bytes untrusted; letting them decide a stream's lifetime would let page-adjacent content choose how long a connection lives.
- **One idle window for every stream.** Rejected: any value long enough for an editing pause is far too long for a stalled HTTP exchange, and any value short enough for the latter breaks hot reload.
- **Keeping a flat absolute lifetime and making it long.** Rejected: it would leave stalled streams open for hours, and would still cut a working WebSocket at an arbitrary instant with no signal an operator could interpret.
- **Terminating the WebSocket in the gateway and re-originating it.** Rejected: the gateway would then have to implement RFC 6455 framing, negotiate extensions on the browser's behalf, and compute `Sec-WebSocket-Accept` itself. Relaying the handshake instead means the browser validates the handshake against the development service, and the gateway's WebSocket knowledge stops at recognising the upgrade.

## Follow-up

- Make the connector's idle windows configurable, so the two ends can be tuned together (`docs/CONNECTOR_PROTOCOL.md` §20).
- HTTP/2 and QUIC remain deferred. Neither this decision nor its implementation moves towards them; an `h2c` upgrade is refused rather than partially supported.

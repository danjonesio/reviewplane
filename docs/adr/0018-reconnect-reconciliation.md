# ADR-0018: Reconnect reconciliation is control-plane authoritative and fails closed

- Status: Accepted
- Date: 2026-07-30

## Context

`docs/CONNECTOR_PROTOCOL.md` §17 has always said that a reconnecting connector reports what it holds and the control plane answers with desired state. It did not say what happens between those two moments, which is the part that decides whether reconnect is a recovery mechanism or an authorisation hole.

Development VMs are restarted, laptops sleep, home networks drop and control planes are upgraded. Two failures are available, and they are opposites:

- if a reconnect loses the route registry, every review session in progress dies and the human re-publishes by hand;
- if a reconnect restores whatever the connector happened to be holding, then reconnecting extends an authorisation that had lapsed, and a connector that had been revoked, expired or re-pointed keeps serving.

Stage 0 also had a smaller version of the same gap in the other direction: the connector's `RouteTable` is in memory, so a restarted process served nothing and a stream for a route it no longer knew was reset with `ROUTE_EXPIRED` — correct, but indistinguishable from a route that really had expired, and requiring a re-publication nobody asked for.

The Stage 0 exit criterion "Protocol round trip survives connector reconnect" (`docs/ROADMAP.md` §2) cannot be met by either failure, so the shape of the exchange had to be decided rather than left to each implementation.

## Decision

**1. The control plane is the authority, and its answer wins in every disagreement.** The connector's `connector.reconnect.request` is a claim, never an authorisation. The `connector.reconnect.response` names one decision per route — continue or revoke — and the connector obeys it. The full decision table is in `docs/CONNECTOR_PROTOCOL.md` §17: continue only where the route is still within its TTL, still authorised for that connector, and still points at the destination the record names; revoke otherwise.

**2. The connector serves nothing between the request and the answer.** It withdraws every route from service *before* it sends the request. Three properties fall out of that ordering rather than out of a check someone must remember:

- a route the response does not name is not served, so a partial or truncated answer fails closed;
- a reconciliation that times out leaves the connector serving nothing, rather than serving traffic nobody has re-authorised;
- reconnecting is never a way to extend an authorisation that had lapsed.

**3. A continued route restates its whole publication.** The response carries the authoritative `route_publish` for every route it continues, so a connector that lost its route table to a restart resumes the same `route_id` against the same destination with no second publication exchange. The connector still applies its own §11 validation to that restatement, because schema acceptance is not authorisation; it does not re-run the startup probe, because the control plane has already decided the route is worth carrying and a destination that has gone away is better reported per stream as `PORT_NOT_LISTENING` than silently dropped.

**4. Every established channel reconciles, including the first.** A restarted process and a restarted network are indistinguishable from the control plane's side and need the same answer, so there is no separate "first connection" path to get wrong.

**5. Identity survives a reconnect; routes do not.** A revoked identity is refused before the channel exists (§18). A valid identity claiming another connector's route is answered `revoke` / `not_authorised`, and the other connector's record is left untouched.

**6. The backoff attempt counter bounds consecutive failures, not the connector's lifetime.** It resets when a channel stayed up longer than the longest backoff delay. It does not reset for a channel that was accepted and immediately dropped, so a flapping peer is still backed off from and an unbounded tight loop remains impossible.

**7. Version 1 gains two message types and no more.** `connector.reconnect.request` and `connector.reconnect.response` are added to `packages/protocol`. No `route.revoke` is added: withdrawing a single route from a connector that is still connected remains unaddressed at Stage 0, and revocation reaches the tunnel through the gateway immediately and the connector's own table at its next reconnection.

## Consequences

- A forced disconnect and reconnect restores service with no operator action, which is the Stage 0 exit criterion, and it is asserted as three requests rather than one: before, during and after.
- A reconnect cannot silently redirect traffic to a different environment. A destination that disagrees with the record closes the route rather than continuing it, which is `docs/ARCHITECTURE.md` §14 enforced at the reconciliation rather than only at publication.
- The window between the request and the answer is a real outage: the connector serves nothing during it, so a slow control plane costs availability. That is the intended trade — the alternative is serving unreconciled routes — and it is bounded by the desired-state timeout.
- Reconciliation must be cheap, because it is on the path of every reconnect. It performs no network I/O on the connector side and one bounded set of queries on the control-plane side.
- A route revoked while its connector is connected is still carried by that connector until it next reconnects. The gateway stops carrying it immediately, so no browser reaches it; the residual exposure is a connector holding a loopback socket for a route the control plane has closed. Closing that gap needs a `route.revoke` message and a further ADR.

## Alternatives considered

**Trust the connector's claim and continue what it reports.** Simplest, and the exact failure the security requirement names: a route would outlive its authorisation through a reconnect.

**Keep serving routes while reconciliation is outstanding.** Avoids the availability gap, but a reconciliation that never completes then leaves traffic flowing to a destination nobody has re-authorised — the timeout would become the hole.

**Require re-publication after every reconnect.** Safe, and it makes a laptop sleeping cost the human a manual step per route. The exit criterion asks for automatic restoration precisely because that is the experience it is meant to prevent.

**Put the reconnect exchange on the `upgrade` channel.** It carries the §19 classification, but it reconciles state and only reports a version as part of doing so; `control` is where commands and acknowledgements live.

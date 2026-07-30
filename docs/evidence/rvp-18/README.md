# RVP-18 evidence: the protocol round trip survives a connector reconnect

A point-in-time capture from one run of the tests below, committed so that the
pull request can show it and a reviewer can read it without running anything.
It is **not** a fixture and nothing asserts against it: the tests regenerate all
of it, and the identifiers, timings and timestamps are from one run and mean
nothing on another.

Regenerate with:

```bash
# the round trip, the reconciliation log and the reconnect distribution
cd services/connector
REVIEWPLANE_EVIDENCE_DIR=../../docs/evidence/rvp-18 go test ./internal/protocolsim/ -count=1

# the event sequence, against a real database and a real connector process
cd apps/server
REVIEWPLANE_EVIDENCE_DIR=../../docs/evidence/rvp-18 \
  node --conditions=development --test --test-concurrency=1 test/connector-reconnect.test.ts
```

| File | What it shows |
|---|---|
| `round-trip.txt` | The three-part assertion of the Stage 0 exit criterion: a request before the interruption reaches the authorised environment, a request during it fails with `CONNECTOR_OFFLINE` rather than hanging, and a request after it reaches the same environment over the same `route_id` — with no operator action between them. |
| `reconciliation-log.txt` | One reconciliation decision as the connector logged it, carrying the connector identity, the route identifier, the decision and its reason (`docs/ARCHITECTURE.md` §15). No credential appears, because the payload has no field for one. |
| `reconnect-distribution.txt` | Ten forced disconnects, each timed from the partition to the first request the resumed route served, plus the backoff delays the connector actually used. The delays vary and none exceeds the configured 800 ms maximum, which is bounded jittered backoff measured rather than asserted. |
| `event-sequence.txt` | The audit trail across one full cycle: the connector disconnects, the browser session bound to its route is degraded, the connector reconnects, and the session resumes. |

The reconnect distribution is measured with a deliberately short backoff —
`initial_delay: 100ms`, `max_delay: 800ms`, `factor: 2`, `jitter: 0.3` — so that
the growth and the ceiling are both observable in seconds. The shipped defaults
are one second and sixty seconds (`docs/CONNECTOR_PROTOCOL.md` §20).

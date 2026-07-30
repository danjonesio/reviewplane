# RVP-14 evidence: WebSockets, streaming and hot reload through a route

A point-in-time capture from one `pnpm test:e2e` run, committed so that the
pull request can show it and a reviewer can read it without running the stack.
It is **not** a fixture and nothing asserts against it: the scenario regenerates
all of this on every run into `deploy/compose/e2e/evidence/`, which is ignored.
The identifiers and the timings in it are from that one run.

Regenerate with:

```bash
pnpm test:e2e
```

| File | What it shows |
|---|---|
| `hmr-before.png`, `hmr-after.png` | The Vite fixture in central Chromium, either side of a source edit made on the development machine. |
| `hmr-before.txt`, `hmr-after.txt` | The accessibility snapshots of the same two moments, which is where the proof is machine-readable. |
| `websocket-echo.txt` | Three request/response exchanges and a clean close over a WebSocket carried by the route. |
| `sse-timing.txt` | Server-sent events with the gap between each consecutive arrival, in milliseconds. |
| `performance-baseline.txt` | Tunnel throughput and hot-reload latency, with the configuration and the machine they were measured on (`docs/TESTING.md` §12). |
| `gateway-metrics.txt` | The gateway's counters at the end of the run, including the upgrade accounting. |

## The hot-reload proof

The claim is *a source edit on the development VM is applied in central Chromium
without a full page reload*, and it needs both halves. Editing
`examples/dev-fixture/vite-app/src/Marker.tsx` inside the running development
environment changes the marker; a click counter held in React state in the
parent component is what a full reload would destroy.

Before the edit:

```text
- heading "HMR marker: ALPHA" [ref=e6]
- heading "clicks: 3" [ref=e7]
```

After it:

```text
- heading "HMR marker: BRAVO" [ref=e6]
- heading "clicks: 3" [ref=e7]
```

The marker changed, so the edit arrived. The counter survived, so the page was
not reloaded. Either fact alone proves nothing: a full reload also changes the
marker, and it also resets the counter to zero.

## The streaming proof

Server-sent events fail in a recognisable way when a hop buffers: every event
arrives at once at stream close. The fixture page therefore measures its own
arrival gaps rather than its final content, and reports whether they are
incremental.

```text
- heading "sse: incremental events=6 min-gap=400ms" [ref=e6]
- heading "sse gaps ms: 400, 401, 400, 401, 400" [ref=e7]
```

The development service produced one event every 400 ms. The gaps the browser
observed are the same 400 ms, so nothing between them accumulated the stream.

## The WebSocket proof

```text
- heading "ws: echoed=3 code=1000 clean=true" [ref=e6]
```

Three messages sent from the page and three correct echoes received, then a
close initiated by the browser and answered by the development service with the
same code. That is bidirectional frames and closure semantics in both
directions, over the real gateway, the real data channel and the real
connector.

## The counters

`gateway-metrics.txt` records two upgrades requested and two switched — the
WebSocket echo and the Vite hot-reload socket — with one still open when the
metrics were read, which is the hot-reload socket doing its job.

# RVP-11 evidence: a loopback development service loaded by central Chromium

A point-in-time capture from one `pnpm test:e2e` run, committed so that the
pull request can show it and a reviewer can read it without running the stack.
It is **not** a fixture and nothing asserts against it: the scenario regenerates
all of this on every run into `deploy/compose/e2e/evidence/`, which is ignored.
The identifiers in it are from that one run and mean nothing on another.

Regenerate with:

```bash
pnpm test:e2e
```

| File | What it shows |
|---|---|
| `screenshot-desktop-1440x900.png` | The fixture home page as central Chromium rendered it through the tunnel, at the desktop viewport `AGENTS.md` requires. |
| `screenshot-mobile-390x844.png` | The same page at the mobile viewport, device scale factor 2. |
| `network-summary.txt` | Every request the development service received through the route, with the status it answered and the `Host` it was given. Twenty requests, zero failures. |
| `header-behaviour.txt` | The observed `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For` behaviour, which is what `docs/CONNECTOR_PROTOCOL.md` §13.1.1 records. |
| `absolute-url-finding.txt` | The expected absolute-URL failure mode, characterised rather than repaired (§13.2). |
| `event-sequence.txt` | The project's event stream, carrying `published_service.requested`, `published_service.ready`, `browser_session.allocated`, `browser_session.ready` and `browser_session.navigated`. |
| `ss-ltnp-during-load.txt` | Listening sockets inside the development environment while the page was loading. Loopback only, which is Stage 0 exit criterion 5. |

The screenshots are PNGs at exactly 1440x900 and 390x844; the scenario asserts
their dimensions against the requested viewport rather than trusting the
capture.

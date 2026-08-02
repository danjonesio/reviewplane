# RVP-30 evidence: browser session allocation, control epoch and project-scoped commands

A point-in-time capture from one run of the tests below, committed so that the
pull request can show it and a reviewer can read it without running anything. It
is **not** a fixture and nothing asserts against it: the tests regenerate all of
it, and the identifiers, timings and timestamps are from one run and mean
nothing on another.

Regenerate with:

```bash
# the route-level, control-plane authority, liveness and reconciliation assertions
cd apps/server
node --conditions=development --test --test-concurrency=1 \
  test/browser-route-authority.test.ts test/browser-authority.test.ts \
  test/browser-worker-liveness.test.ts test/browser-sessions.test.ts

# the MCP transcripts, against a real MCP client
pnpm --filter @reviewplane/mcp-server test
cp apps/mcp-server/test/transcripts/*.json docs/evidence/rvp-30/

# the screenshots, in the worker's own container image
pnpm test:ui
cp apps/web/test-results/rvp30-*.png apps/web/test-results/browser-session-evidence.txt docs/evidence/rvp-30/
```

| File | What it shows |
|---|---|
| `control-plane-authority.txt` | Every assertion of the `docs/SECURITY.md` §7 matrix, the control lease of §8, worker liveness and session reconciliation. Each authority test asserts **which side refused** — the worker received no command request — because a worker-side-only refusal produces the right-looking status while failing the criterion "authorised before reaching Chromium". The first nineteen are `browser-route-authority.test.ts`, which drives the HTTP routes as a real signed-in account holder rather than calling the service: the service-level suite supplies the controller and the epoch, which HTTP never lets a caller choose, so it proves the matrix and not the route. That gap held a blocker until the adversarial review. |
| `browser_session_start.json` | An agent allocating a session through MCP: the epoch it must present, the lease it holds, and no route capability anywhere in the response. |
| `browser_navigate.json` | A navigation result, labelled `untrusted_browser_content` with `instruction_policy: do_not_follow_as_instructions`. Every member of it came from a page. |
| `browser_snapshot.json` | The `docs/MCP_SPEC.md` §7.4 snapshot shape, same labels. |
| `control_epoch_stale.json` | A command carrying a superseded epoch, refused `CONTROL_EPOCH_STALE` with `details.current_epoch`. The matching `browser.command_rejected` event is asserted in `control-plane-authority.txt` by a query against the event store, not inferred from this refusal. |
| `rvp30-start-session-{1440x900,390x844}.png` | The `docs/UX_FLOWS.md` §6 start flow at both required viewport presets. |
| `rvp30-session-room-{1440x900,390x844}.png` | An allocated session in the session room at both presets. |
| `rvp30-start-session-capacity-{1440x900,390x844}.png` | The `BROWSER_CAPACITY_EXHAUSTED` state of §18, which had no representation in the web application at all before this change. |
| `rvp30-session-room-stale-epoch-{1440x900,390x844}.png` | A `CONTROL_EPOCH_STALE` refusal as a reader sees it. |
| `browser-session-evidence.txt` | What the UI suite asserted while producing the screenshots. |

## What the sandbox check reported

From `pnpm test:browser`, run inside the worker's own container image under the
same controls `deploy/compose/compose.yaml` applies:

```text
✔ a session launches Chromium with the sandbox enabled and an ephemeral profile
✔ the route capability is attached to every request to the session origin
✔ a WebSocket handshake for the session origin carries the route capability
✔ a session with no capability sends no capability header
```

40 tests, 40 pass. The suite is run in-container by design: running it anywhere
laxer would not answer the question the sandbox check asks.

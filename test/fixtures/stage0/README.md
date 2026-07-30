# Stage 0 upgrade fixture

A frozen Stage 0 ReviewPlane installation: a PostgreSQL dump at the Stage 0
migration head, the artefact-store files its rows reference, and a manifest
describing both.

It exists for one job. The Stage 1 exit criterion "upgrade from previous stage
data fixture succeeds" (`docs/ROADMAP.md` §3) and the upgrade sequence of
`docs/TESTING.md` §13 require migrations to be tested against data a previous
release actually wrote, not against a freshly created schema. RVP-56 —
"Backup and restore scripts, and upgrade from a previous-stage data fixture" —
consumes this directory: restore it, start the new version, apply the
migrations, and verify that the reviews, findings, annotations and verification
evidence are still intact and viewable.

It is captured now, while `main` is the Stage 0 build, because it cannot be
captured later. Once Stage 1 migrations exist there is no Stage 0 installation
left to dump.

## What it contains

| | |
|---|---|
| Organisation | `Refresh` (`refresh`), beside the `org_default` row the server creates on first start |
| Project | `Refresh Surplus` (`refresh-surplus`) |
| Workspace | `/workspace/refresh-surplus` on branch `redesign` |
| Review | **`bugs-on-homepage`**, status `AWAITING_HUMAN_REVIEW` |
| Finding 1 | "Hero heading overlaps the navigation below 900px", `high`, human-authored, captured at 390x844 dpr 2, status `AWAITING_HUMAN_REVIEW` |
| Finding 2 | "Header padding is uneven at 1440px", `medium`, human-authored, captured at 1440x900 dpr 1, status `OPEN` |
| Annotations | 3, normalised to 0–1 against their artefact's content rectangle: a `rectangle` and an `arrow` on finding 1, a `numbered_marker` on finding 2 |
| Verification | One agent-submitted verification, status `submitted`, with an **after screenshot** linked at role `after` |
| Comment | One agent comment on finding 1 |
| Artefacts | 3 PNG screenshots (two before, one after), digest-verified and measured |
| Events | The full append-only stream the loop produced, including the agent-attributed records |

`manifest.json` carries the authoritative inventory: product commit, schema
version and migration list, per-table row counts a restore must reproduce, the
artefact inventory with digests and sizes, and a SHA-256 for every committed
file.

Human acceptance is deliberately absent. Stage 0 has no acceptance surface, so
a fixture containing an accepted finding would not be Stage 0 data. The review
and its resolved finding sit at `AWAITING_HUMAN_REVIEW`, which is exactly where
an agent has to leave them (`AGENTS.md`, ADR-0020).

## Files

```text
manifest.json   inventory, versions and checksums
database.sql    pg_dump plain SQL, schema and data, --column-inserts
artefacts/      the filesystem artefact store, sha256/<xx>/<62 hex> (ADR-0012)
capture.sh      regenerates everything in this directory
manifest.py     the manifest step of capture.sh
verify.sh       restores the dump and checks it against the manifest
```

## How it was produced

`capture.sh` runs
`apps/mcp-server/scripts/capture-stage0-fixture.ts` inside the browser worker's
own image, under the container controls of `deploy/compose/compose.yaml`, with
a disposable PostgreSQL beside it on an internal network. The driver runs one
complete product loop against real components — a real PostgreSQL, the real
control-plane process, the real MCP server, a real Chromium browser worker in
its own process, and the official MCP TypeScript SDK as the agent client:

1. a human opens browser sessions on the fixture application at both required
   viewports and captures the defect;
2. the human creates the named review `bugs-on-homepage` with two annotated
   findings;
3. the agent retrieves the review over MCP, claims it, changes the application,
   captures the after screenshot and submits verification;
4. both the finding and the review end at `AWAITING_HUMAN_REVIEW`.

Only the connector and the tunnel gateway are stubbed. Stage 0 ships no
connector fixture, the schema itself records that "Stage 0 has no connector",
and the connector's own end-to-end proof is `pnpm test:e2e`; the rows a
connector would add are session-scoped route state rather than review history.

The driver lives under `apps/mcp-server/scripts/` rather than here because it
imports `@reviewplane/server` and the MCP SDK, and a file outside a workspace
package resolves neither.

To regenerate — which should only be done to fix a defect in the fixture, never
after Stage 1 migrations exist:

```bash
pnpm install
bash test/fixtures/stage0/capture.sh
```

## Verifying it

```bash
bash test/fixtures/stage0/verify.sh
```

This restores `database.sql` into a fresh disposable PostgreSQL and checks that
the committed files match the manifest's checksums, that the schema is at the
recorded migration head, that the review, findings, annotations, comment and
verification came back with the recorded statuses, that every annotation
geometry is still normalised, that every artefact the metadata references is
present with a matching digest, and that no key material rode along. It needs
Docker and nothing else — no Chromium, no workspace install.

## What is deliberately excluded

- **Key material.** `connector_tls_material` holds the connector certificate
  authority's private key, so its rows are excluded from the dump and the
  exclusion is asserted before the fixture is written. A restore of this fixture
  generates a new authority. `docs/SECURITY.md` §20 and RVP-56 both make silent
  inclusion of key material a defect rather than a convenience.
- **Anything large.** Screenshots only: no traces, no videos, no live frames.
  Live frames are ephemeral by design and never in a backup.

Two categories of low-value credential material remain, because removing them
would misrepresent what an installation holds:

- `agent_credentials` stores the SHA-256 of a throwaway token that expired
  within a day of capture. The token itself was never written down.
- `artefact_access_grants` holds expired grant identifiers. A grant
  identifier is half of a pair — the other half is the caller's own credential
  (`docs/SECURITY.md` §18) — so on its own it opens nothing, and these are past
  their expiry in any case.

# ADR-0034: Browser workers are a deployment-wide shared pool, administered by the deployment administrator

- Status: Accepted
- Date: 2026-08-06

## Context

`apps/server/migrations/0042_browser_workers.sql` defines `browser_workers` with
no organisation column: `id`, `name`, `credential_sha256`, `worker_version`,
`browser_type`, `browser_version`, `capacity`, `labels`, `sandbox_enabled`,
`status` and the liveness timestamps. A worker's relationship to tenant data is
`browser_worker_projects`, an assignment an administrator writes; the worker
itself belongs to no organisation.

Nothing said whether that was the design or an omission, and the routes that
administer the pool were written as though it did not matter. All three tested
`principal.projectIds !== null` and refused if so:

| Route | |
| -- | -- |
| `PUT /api/v1/browser-workers/:workerId/assignments` | replaces a worker's whole assignment |
| `GET /api/v1/browser-workers` | the fleet, with capacity, versions and liveness |
| `GET /internal/v1/protocol` | one constant example frame |

`projectIds === null` means "not narrowed to specific projects". It is the shape
**every real sign-in issues** — `modules/identity/routes.ts` issues it for the
install-token claim and for the password path alike — so the predicate reads
"is an ordinary organisation-wide user", not "is an administrator". Read as
authority over a resource with no organisation column, it admitted every tenant
to the deployment's whole worker fleet (RVP-91).

The consequence was not only disclosure. `WorkerRegistry.assign()` deletes every
existing assignment row before inserting, so one tenant naming its own project
both seized a worker **and detached it from another tenant**. The victim's
sessions then fail to schedule with `BROWSER_CAPACITY_EXHAUSTED` — the same code
a genuinely full worker produces, with nothing to tell the two apart.

`requireOrganisationAdministrator` states the Stage 1 rule in its own words as
administering *the organisation*, and that is sound wherever it is applied:
projects, connectors and published services all constrain the record by
`principal.organisationId` afterwards. A resource the deployment owns has no
such term to add, so the guard silently became "administers the deployment"
without anyone deciding that it should.

This is a trust-boundary question — who may act on infrastructure that spans
tenants — and not an implementation detail, so it is recorded here.

## Decision

### A browser worker is deployment infrastructure, not tenant data

`browser_workers` gains **no** organisation column, and the registry is not
partitioned. In a self-hosted ReviewPlane deployment the workers are containers
the operator runs, sized and upgraded by the operator, sharing the operator's
host. They are the same kind of thing as PostgreSQL and the artefact store,
which no tenant owns either. Modelling them per organisation would make a
deployment's spare capacity unusable by whichever tenant needed it, and would
give a tenant a record it can neither create, size nor restart.

The tenancy that matters is already expressed, and stays where it is:
`browser_worker_projects` is the assignment, `docs/SECURITY.md` §6.4 makes "not
yet assigned" mean "serves nothing" with no wildcard, and ADR-0026 restates the
assignment on every heartbeat so a revocation takes effect within one interval.

### What follows: worker administration requires the deployment administrator

Because the resource spans organisations, the authority over it must too. The
three routes above now call `requireDeploymentAdministrator`, and **the test is
`organisationId === null`**.

Stage 1 has no roles (`docs/DOMAIN_MODEL.md` §5 defers them to Stage 3), so the
rule is scope, as it is everywhere else in Stage 1. The only principal that is
deployment-wide by construction is the ADR-0016 bootstrap administrator: the
install token presented as a bearer credential, or the cookie session
`POST /api/v1/auth/viewer-sessions` exchanges it for. `bootstrapPrincipal()` is
the one place that value is minted and it carries `organisationId: null`; every
account sign-in carries a real organisation. So in Stage 1, **"deployment
administrator" means the bootstrap principal**, and "belongs to no organisation"
and "administers the deployment" are the same statement.

`projectIds === null` is not that test and must never be used as one. It is
recorded in the guard's own docstring, because the next person will reach for it
otherwise: it is the third distinct surface on which this shape has produced a
finding.

### An assignment may only name projects the caller can reach

`PUT .../assignments` resolves every identifier in `project_ids` through
`resolveProject` before `assign()` writes anything. For the bootstrap principal
that admits every real project and refuses an unknown one with
`RESOURCE_NOT_FOUND`, rather than leaving the foreign key to report it after the
delete has already run. When roles arrive it is already the term that confines a
narrower administrator, and the check is at the route rather than in each
caller's head.

### `GET /internal/v1/protocol` is corrected for consistency, not for exposure

It serves one constant example frame. There is no tenant data in it and none
reachable from it, so unlike the other two it disclosed nothing and enabled
nothing. It is changed so that the deployment-administrator rule has one
statement rather than two, and the PR says so rather than implying the three
routes were equivalent.

## Consequences

- One authority predicate is added, not a second authority model.
  `requireOrganisationAdministrator` keeps its meaning and its callers;
  `requireDeploymentAdministrator` is strictly narrower and is used only where
  the resource has no organisation.
- An organisation-wide user can no longer see that other tenants exist by way of
  the worker fleet, nor affect their capacity.
- An organisation-wide user can no longer assign a worker to **its own**
  project either. That is a real reduction in what a signed-in user may do, and
  it is intended: assignment decides which tenants share a container, which is
  an operator decision. Stage 3's roles are where a per-organisation
  administrator could regain it, under a role rather than under a scope.
- The bootstrap **cookie** session issued by the ADR-0016 exchange still cannot
  call `PUT .../assignments`: it carries no CSRF token, and the strict
  `requireCsrfToken` refuses every state-changing route to a token-less session.
  An operator assigns with the bearer token, as `deploy/compose` and the
  end-to-end scenario already do. This is unchanged by this ADR.
- Scheduling stays unpartitioned. `schedulableRows()` and `active()` gain no
  organisation term, because there is no organisation to filter by — the
  assignment is what confines a session to a worker, and it already did.
- Stage 2's worker labels and multi-worker scheduling (`docs/ROADMAP.md`)
  inherit a pool with no tenancy to reconcile.

## Alternatives considered

**Add `organisation_id` to `browser_workers` and partition the registry.**
Rejected. It would give each tenant a private pool in a product whose Stage 1
deployment runs one worker, so the common configuration becomes "one tenant can
schedule and the others cannot". It also invents an owner for a container the
operator started: nothing in the registration frame names an organisation, so
the column would be assigned by the control plane at registration and would then
have to be re-assigned by hand whenever the deployment's tenants changed. The
assignment table already expresses everything a tenant boundary needs here.

**Keep `requireOrganisationAdministrator` and add an organisation term to the
queries.** There is no term to add: the table has no such column, which is the
whole finding. Deriving one from the worker's current assignments would make
authority depend on the state the request is about to change — the same
compare-the-record-to-itself shape ADR-0028 removed from the lifecycle routes.

**Make the deployment administrator a role now rather than a scope.** Rejected
as premature. Stage 3 introduces roles for the whole product
(`docs/DOMAIN_MODEL.md` §5); a single role invented here would be a second
authority model to reconcile later. The predicate is one function, and adding
roles replaces it and nothing else.

**Leave `GET /internal/v1/protocol` alone.** Defensible on severity — it
discloses nothing — and rejected because two statements of the same rule is how
the wrong one gets copied.

## Follow-up

- `docs/SECURITY.md` §7 distinguishes organisation administration from
  deployment administration and records that `projectIds === null` is not an
  authority test.
- `docs/API.md` §11 records that the two worker-administration routes require
  the deployment administrator, and that an assignment's `project_ids` are
  resolved before anything is written.
- RVP-70's liveness work and RVP-45's annotation work build on this surface and
  need no change: neither reads a worker's tenancy, because a worker has none.

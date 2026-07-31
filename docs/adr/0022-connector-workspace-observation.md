# ADR-0022: Report workspace Git context as its own bounded message on the connector `events` channel

- Status: Accepted
- Date: 2026-07-31

## Context

`docs/CONNECTOR_PROTOCOL.md` §9 has always listed what a connector may report
about a checkout — normalised repository remote identity, branch, HEAD commit,
dirty status and a display label — and `docs/ARCHITECTURE.md` §4.7 has always
made "detect configured workspaces and Git state" a connector responsibility.
Neither said how that state reaches the control plane, and version 1 of the
protocol had no message capable of carrying it.

Stage 1 cannot leave that open. A review's captured source context is
interpreted against the workspace it was captured from (`docs/DOMAIN_MODEL.md`
§9 and §24), `docs/MCP_SPEC.md` §7.7 requires a verification's `branch` to equal
the branch a registered workspace is on, and the enrolment screen of
`docs/UX_FLOWS.md` §5 must report a detected authorised workspace before an
operator can believe the connector is working. All three need the control plane
to hold branch, commit and dirty state, and to hold them **while they change**
rather than only at the moment a channel is established.

Three properties make this more than a plumbing choice.

**It is a report about somebody else's development machine.** The connector runs
where the source code is, and `AGENTS.md` forbids it from being a source-code
uploader. Whatever carries this state decides what a future change could carry
with it, so the boundary belongs in a place a code change cannot quietly widen.

**It is a claim, not an authorisation.** The connector states which project a
checkout belongs to. A connector enrolled for one project that names another —
by misconfiguration or otherwise — must not thereby write into that project.

**The connector, not the control plane, knows the workspace identifier.** A
`route.publish` names a `workspace_id` (§11) and the connector refuses one it
does not recognise, so the identifier has to be the value the connector already
holds. That makes the identifier something a peer chooses, which is exactly the
shape that becomes a way to claim somebody else's row if nothing stops it.

## Decision

**1. Version 1 gains one message type: `workspace.observed`.** It travels on the
`events` channel, connector to control plane, carrying the
`workspace_observation` payload bounded at 2 048 bytes. `connector_id` is
required on its envelope, like every other post-enrolment message. It is the
first message defined for the `events` channel, which §6 previously reserved.

**2. One observation is one message.** The schema binds one
`workspace_observation` to one envelope; there is no batch form. A batch would
need a second message type, a second bound and a partial-failure rule, and the
bound on a single observation is what keeps the frame small enough to be
uninteresting.

**3. The payload's privacy properties are schema properties, not code
properties.** `workspace_observation` has members for `workspace_id`,
`project_id`, `path_hash`, `display_label`, `repository_identity`, `branch`,
`head_commit`, `dirty` and `observed_at`, and `additionalProperties` is false.
There is no member capable of carrying source file contents, a changed-path
list, a process detail or a full filesystem path. `dirty` is a boolean, so
"which files changed is not reported" is a statement about what the message can
express rather than about what an implementation currently chooses to send.
`display_label` refuses `/`, `\` and control characters, so a full path cannot
be smuggled through the field that exists precisely so that one is not stored,
and `path_hash` is a `sha256:<hex>` digest of the absolute path, which
identifies the same checkout across observations without disclosing the
directory layout it names.

**4. It is sent on connect, on change and on reconnect.** The full set goes out
once per established channel, after §17 reconciliation has completed and never
interleaved with it; after that only the workspaces whose branch, head commit or
dirty state actually moved are sent. A connector on a machine nobody is working
on is silent.

**5. The §17 reconnect claim keeps its own field and shares the scalars.**
`workspace_head_state` remains part of `connector.reconnect.request`, and its
`branch` and `head_commit` members now `$ref` the same `git_branch` and
`git_commit` definitions `workspace_observation` uses, so the two cannot drift.
The claim is answered from the last observation rather than by observing afresh,
because it is the first frame on an established channel and nothing may delay
it.

**6. The control plane re-derives the project scope and refuses with
`PROJECT_NOT_AUTHORISED`.** The reported project identifier, the organisation
the client certificate resolved to and the project the identity was enrolled for
all appear in one SQL predicate, so a project this identity may not act for
produces no row rather than a row a later branch has to remember to reject. A
refusal closes the channel with code 1008 and that class, which is §5.3's
existing mechanism and needs no new message type.

**7. The refusal is terminal on the wire.** `PROJECT_NOT_AUTHORISED` joins
`ENROLMENT_TOKEN_INVALID`, `IDENTITY_REVOKED`, `PROTOCOL_UNSUPPORTED` and
`UPGRADE_REQUIRED` as a close reason a connector MUST NOT retry with the same
configuration: a connector configured for a project it may not touch is a
misconfiguration only an operator can fix, and retrying would loop until
somebody noticed. This governs a close reason only. A `route.publish.ack`
carrying `PROJECT_NOT_AUTHORISED` in its payload refuses one publication, not
the channel, and the connector keeps serving everything else it was authorised
for.

**8. A workspace record is owned by the environment that reported it, and the
connector supplies the identifier.** The identifier is stored as the connector
reported it, because it is the value a publication names. Ownership is what
bounds that: a connector may create or update only a record belonging to its own
environment, or one belonging to no environment at all — a workspace an operator
registered through `docs/API.md` §4.3, which it adopts because an operator named
that exact path and this connector observes that exact path. A record owned by
another environment is refused with the same class a foreign project gets, so
claiming another environment's workspace and naming a project outside the
enrolled scope are one outcome rather than two.

Ownership has to be checked on the update path and not only on the insert. An
earlier draft of this decision relied on `on conflict do nothing` alone, which
guards only an insert — and an observation naming a workspace that already
exists never reaches one. A connector could therefore take over another
environment's record inside the same project and rewrite its branch and head
commit, which is precisely the value `docs/MCP_SPEC.md` §7.7 checks a
verification against. The check is now a locked read followed by an explicit
refusal, with the ownership repeated in the update's own predicate.

A workspace's identity is `(project_id, environment_id, path_hash)` for a
reported record and `(project_id, path_hash)` for a registered one. The
environment belongs in the key because `/home/dev/app` on two development
machines is two checkouts: without it they collide into one record and rewrite
each other every observation interval.

**9. An unchanged repeat writes no event.** A first observation writes
`workspace.observed`; a change to branch, head commit or dirty state writes
`workspace.head_changed` carrying both sides; an observation that moved nothing
refreshes `last_observed_at` and writes no event at all. `docs/EVENTS.md` §7
requires a high-frequency signal to be sampled or summarised rather than
emitted as a durable event for every occurrence, and a connector reports on an
interval whether or not anything happened.

**10. Broad filesystem scanning stays disabled and this build performs none.**
Only the paths named in the `workspaces` block are ever looked at.
`privacy.discover_workspaces: true` is refused at startup rather than accepted
and ignored, and `privacy.report_changed_paths: true` is refused for the reason
in point 3: there is no member for a changed-path list, so accepting the setting
would tell an operator their policy had been applied when nothing about what is
sent had changed.

## Consequences

### Positive

- The control plane holds branch, head commit and dirty state for every
  authorised checkout, and holds them as they change, which is what a review's
  captured context, a verification's branch assertion and the enrolment screen's
  completion report all need.
- What a connector may say about a development machine is bounded by a reviewed
  schema. Widening it is a protocol change with a fixture corpus behind it, not
  an added field in one service.
- A connector that names a project it may not act for stops with a named cause
  instead of writing into that project or retrying forever.
- Two workspaces cannot collide into one record and one workspace cannot become
  two. The same directory reported twice by one environment is one row; the same
  path on two development machines is two, because the environment is part of
  the key; and a checkout registered administratively and later observed by a
  connector resolves to the registered row, because both sides hash the same
  bytes and an unowned record is adopted rather than duplicated.
- A connector cannot reach another environment's record at all, so the branch
  and head commit a verification is checked against can only be written by the
  machine the checkout is on.
- The `events` channel now has a defined shape, so the agent-session
  observations it was reserved for arrive as a second message type rather than
  as a first design.

### Negative

- Branch and dirty state are as fresh as the observation interval, which
  defaults to 30 seconds. A control plane reading a workspace record is reading
  what was true when the connector last looked, and no reading here is a
  freshness claim.
- Observing costs `git` invocations on the development machine. They are
  bounded — fixed argument vectors, no shell, bounded output, a deadline each —
  but they are not free, and an operator who wants them rarer says so with
  `git_context.interval`.
- The reconnect claim is bounded at eight workspaces while the observation
  stream is not, so a connector serving more than eight claims a subset and
  reports all of them. The claim is not an authorisation, so the asymmetry
  costs nothing but has to be understood when reading a reconnect log line.
- A workspace whose branch flips back and forth writes an event each way. That
  is deliberate — both sides of the move are what an auditor needs — but a
  scripted branch switch is visible in the event stream.

## Alternatives considered

**Fold the fields into the heartbeat.** Tempting, because a heartbeat already
arrives on an interval. Rejected on two grounds. The heartbeat payload is
bounded at 1 024 bytes and reports one connector, not one workspace, so several
checkouts would not fit and the bound would have to be raised for a reason
unrelated to liveness. More importantly, a heartbeat is liveness: `status`,
uptime, route and stream counts. Mixing context into it would mean the control
plane could not conclude a connector was alive without also accepting a claim
about its filesystem, and §8 deliberately keeps process detail out of that
message.

**Carry it only in the §17 reconnect claim.** The field already exists, so this
looks like the smallest change. It reports on connect and on reconnect and never
on change, which is precisely the case the product needs: a human supervising a
session must see that the branch moved under them. Making reconnect the only
carrier would mean either accepting stale context indefinitely or dropping the
channel to refresh it, and dropping a healthy channel to report a branch name is
worse than the problem.

**One batched message carrying every workspace.** Fewer frames, and a bound that
must accommodate the largest configuration rather than the largest workspace. It
also introduces partial failure — one bad entry in a batch of eight — which
version 1 has no vocabulary to express, and the per-message bound is what keeps
a hostile connector's frame uninteresting.

**Let the control plane derive Git context itself.** It would need the
repository, which means either cloning it or being given credentials for it.
`docs/PRIVACY.md` §2 puts the working tree on the development environment and
says the control plane does not need repository contents to provide the core
workflow. Deriving would reverse that for a branch name.

**Trust the reported `project_id`.** The connector already authenticated with a
client certificate, so the temptation is to treat what it says as settled.
Authentication establishes which connector is speaking, not what it may act for;
`docs/SECURITY.md` §3 puts the connector in the development-environment zone
rather than the control-plane one, and a claim accepted because its sender was
authenticated is the failure ADR-0018 names for routes.

## Follow-up

- Bounded root scanning of a configured directory for unlisted checkouts —
  discovery mode 3 of §9 — remains unimplemented and refused by configuration.
  It needs its own bounds and its own decision about what an operator is
  consenting to.
- Review staleness (`docs/DOMAIN_MODEL.md` §24) compares a captured context
  against a current workspace. This ADR supplies the current side; the
  comparison is Stage 2 work and no field here asserts freshness in the
  meantime.
- Agent-session observations were the other use the `events` channel was
  reserved for. They arrive as a further message type with RVP-49, alongside the
  local MCP bridge's credential exchange.

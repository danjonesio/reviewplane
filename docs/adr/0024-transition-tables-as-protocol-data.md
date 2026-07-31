# ADR-0024: The review and finding transition tables, with their authority column, are protocol data

- Status: Accepted
- Date: 2026-07-31

## Context

ADR-0004 made the review the durable system of record and left its lifecycle to
be designed. `docs/DOMAIN_MODEL.md` §14 and §15 then listed the statuses a review
and a finding may hold, and `docs/MCP_SPEC.md` §7.7 listed the six transitions an
agent may perform — but nothing said, in one place, which actor types may request
each of the other transitions, and nothing said where that answer should live.

Three consumers need it.

- The **control plane** must refuse a transition an actor may not make. This is
  the product's central authority invariant: a human-authored finding cannot be
  finally accepted by an agent (`AGENTS.md`, `docs/DESIGN_PRINCIPLES.md` §2), and
  it is a Stage 1 exit criterion.
- The **MCP layer** must advertise a status enumeration an agent can name.
  ADR-0020 already removed the final dispositions from it, which is a structural
  denial rather than a runtime check — but the removal was made by hand against a
  list in a document.
- The **web application** must decide which actions to offer a human. An action
  offered and then refused is a defect a user meets rather than a test does.

Three implementations of one rule is three places for it to drift, and the
direction drift runs in is not symmetric: a table that is too permissive in the
control plane weakens the invariant, while one that is too permissive in the web
application only annoys somebody. So the risk is concentrated in exactly the copy
nobody looks at.

Two further questions had to be settled with it.

`docs/DOMAIN_MODEL.md` §14 says an accepted review is "immutable except for
archival metadata and comments", and in the next line that "reopening an accepted
review creates a new review revision or explicit reopen event". Taken together
those sentences leave the reopen either forbidden by the first or permitted by
the second.

The issue this ADR was written for (RVP-37) states that the review statuses an
agent may request are `in_progress`, `awaiting_human_review` and `blocked`.
`docs/DOMAIN_MODEL.md` §14 defines no `BLOCKED` review status; `BLOCKED` is a
*finding* status (§15).

## Decision

### The tables are data, in `packages/protocol`

Both status machines are declared in
`packages/protocol/schemas/review/v1.schema.json`, under
`x-protocol.vocabularies`, as `review_status_transitions` and
`finding_status_transitions`. Each entry is `from:to:actor_types` — the third
field being the **authority column**, the actor types that may request that
transition.

`packages/protocol/src/review-transitions.ts` is the typed reader for them,
following the existing pattern of `annotation-geometry.ts` and its
`geometry_by_annotation_type` vocabulary: the rule's *content* has one source,
and code decides only what a violation means.

`apps/server/src/modules/reviews/domain.ts` reads that module and keeps its own
job, which is the refusal — which code, which message, which detail a caller
needs in order to recover. It declares no transition and decides no authority.

Absence from a table means refused. There is no default arm.

### Legality and authority are separate refusals

A transition can be legal and still not be this caller's to make, and the two
produce different answers:

- a transition the table does not contain at all is `POLICY_DENIED`;
- a **final disposition** — `RESOLVED`, `WONT_FIX`, `DUPLICATE` — requested by an
  agent is `AUTHORISATION_DENIED`, whoever authored the finding;
- any other transition an agent may not make is `POLICY_DENIED` with
  `details.allowed_transitions`, as `docs/MCP_SPEC.md` §7.7 already required.

`AUTHORISATION_DENIED` is reserved for the authority boundary itself so that the
audit trail and a refusal message both distinguish "you may not decide this" from
"that is not a move from here".

### A refused authority request is audited

`review.status_change_denied` and `finding.status_change_denied` record a
transition a principal asked for and may not make. They are written **outside**
the transaction that refused it, because that transaction rolls back and takes
any event inside it. They are the only events in the catalogue written for
something that did not happen, and they exist because the exit criterion is not
"an agent cannot accept a human's finding" but "an agent cannot accept a human's
finding **and the attempt is audited**".

### Reopening an accepted review is an explicit, audited exception

`ACCEPTED -> CHANGES_REQUESTED` is in the table, permitted to `human_user`, and
admitted by the immutability rule **only when the request carries no other
field**. It records `review.reopened` and increments `reopen_count`. Nothing is
discarded: the findings, verifications, comments and events all stay.

That resolves the tension in §14 in the direction the section's own second
sentence points, and the "no other field" condition is what keeps the first
sentence true — a caller that could retitle an accepted review by reopening it in
the same request would have found a way around the rule rather than an exception
to it.

### An agent reaches three review statuses, and `BLOCKED` is not one of them

There is no `BLOCKED` review status to reach. The three an agent can reach are
`ASSIGNED` (by claiming), `IN_PROGRESS` and `AWAITING_HUMAN_REVIEW` — the same
count RVP-37 states, with the status that exists in place of the one that does
not. `docs/DOMAIN_MODEL.md` §14 outranks an issue, and inventing a review status
to match an issue's wording would have been a lifecycle change made by
accident.

## Consequences

### Positive

- One source for "what may this actor do from here", read by the server, by the
  MCP layer and by the web application.
- The agent-permitted set is provable rather than asserted: a test compares the
  table's `agent_session` rows against the six of `docs/MCP_SPEC.md` §7.7, and
  the same table is what the server enforces.
- Adding a status or a transition is a change to one file, and every consumer
  that reads it is updated by generation rather than by memory.
- The authority boundary leaves a trail whether it is crossed or refused.

### Negative

- The vocabulary is a flat list of strings, because that is what the generator
  emits into TypeScript and Go. The structure is recovered by a parser at load
  time, which fails loudly on a malformed row rather than silently admitting one.
- A transition table in a schema is further from the code that enforces it than a
  constant beside that code, so a reader has one more hop to make. The reader's
  alternative was three tables that disagree.
- Two new event types exist for refusals, and a determined authenticated agent
  can therefore add rows to the audit trail. It is bounded and attributable: the
  credential is authenticated, and the same is already true of
  `authentication.login_failed`.

## Alternatives considered

- **Leave the tables in `apps/server` and let the other layers ask the server.**
  The web application would need a round trip to decide whether to render a
  button, and the MCP layer's advertised enumeration is generated at build time
  from a schema, so it could not ask at all.
- **Put the tables in a shared TypeScript module rather than in the schema.**
  Simpler, and it would exclude Go and any future non-TypeScript consumer from
  the one rule the product is built on. ADR-0013 already decided that shared
  protocol content is generated from schema sources.
- **Encode the authority column as a nested object rather than a string.** The
  generator emits vocabularies as string lists; a second shape would be a
  generator change made for one vocabulary. The `from:to:actors` encoding follows
  `geometry_by_annotation_type`, which already earns its parser.
- **Refuse every non-permitted agent transition with `AUTHORISATION_DENIED`**, as
  RVP-37's wording says. It would make the code uniform and lose the distinction
  `docs/API.md` §13 and `docs/MCP_SPEC.md` §7.7 both draw, and would tell an agent
  that a move nobody can make is a permission problem.
- **Audit refusals to the log only.** `docs/SECURITY.md` §18 would be satisfied
  and §16 would not: the audit question "did an agent try to accept this?" would
  be answerable only from an operator's log retention rather than from the
  project's own append-only trail.

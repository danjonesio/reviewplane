# ADR-0030: A second verification supersedes the first, and exactly one is current

- Status: Accepted
- Date: 2026-08-01

## Context

A finding does not receive one verification. It receives one, a human reopens it,
it receives another, and `docs/DOMAIN_MODEL.md` §15 requires that reopening
"preserves prior verification history" rather than replacing it. So a finding
accumulates claims, and every consumer that displays evidence — the review
viewer, the completion gate of ADR-0029, the export of
`docs/REVIEW_FORMAT.md` — has to answer one question first: which of them is the
claim the finding currently stands on.

Nothing answered it. A second submission simply inserted another row, and the
current claim was whatever `submitted_at DESC LIMIT 1` returned. That works
exactly as long as nobody looks closely. It is a query, not a fact: it has no
answer when two rows share a timestamp, it is answered differently by any
consumer that orders differently, and it cannot express the one thing a reader
most wants to know, which is that this claim *replaced* that one. Nothing in the
database said a finding had ever been re-verified; that had to be inferred from
the shape of a result set.

The history matters more than it first appears. A claim that a defect is fixed,
made and then rejected, and then made again in the same words, is a different
situation from a first claim — and it is exactly the situation a human accepting
work needs to recognise. If the earlier row is not there, or is there but
indistinguishable from the current one, that judgement cannot be made.

## Decision

### Exactly one verification is current, and current has a definition

A finding may hold many verifications. The current one is **the row whose status
is `submitted`**, and there is at most one of them. Every other row on the
finding is `superseded`.

### Supersession is recorded on both rows, and nothing is deleted

A second submission, in one transaction:

- moves the previous row to `superseded`, setting `superseded_at` and the forward
  pointer `superseded_by_verification_id`;
- records `supersedes_verification_id` on the new row.

The superseded record keeps everything it had: its summary, its tested viewports,
its checks and its artefact links. It is not trimmed to a stub and it is not
deleted.

That is the substance of the decision rather than an implementation detail. A
claim whose evidence has been removed is an opinion. Keeping the summary without
the screenshots would leave a record that an agent once said it had fixed
something, with no way to see what it showed — which is worse than keeping
nothing, because it reads as evidence. The history is precisely what a human needs
in order to judge whether the same thing has been claimed before and failed.

Both foreign keys are `ON DELETE RESTRICT`, like every other evidence reference in
this schema. A chain whose links can vanish is not a history.

`superseded_at` is stored separately from the status because a reader asking when
a claim stopped being current should not have to go looking for the submission
that replaced it.

### "Exactly one current" is a property of the database

Migration 0150 creates the partial unique index

```sql
CREATE UNIQUE INDEX verifications_one_current_per_finding
    ON verifications (finding_id)
    WHERE status = 'submitted';
```

so two concurrent submissions on one finding produce one current claim and one
unique violation, rather than two rows that each believe they are the latest.

The service also takes the finding's row lock before it reads or writes anything,
so the ordinary path never reaches the index. That is not a reason to leave the
index out. The lock is a convention the service is trusted to keep; the index is
the constraint that holds when a future call path, a repair script or a second
writer forgets it. The index exists for the path nobody thought of, and its cost
is that it is never observed to do anything.

### The forward reference is `DEFERRABLE INITIALLY DEFERRED`

`verifications_superseded_by_fk` is deferred to commit. The reason is an ordering
deadlock, and it is worth stating plainly because the constraint looks weaker
than its neighbours and is not.

The predecessor must leave `submitted` **before** the successor enters it, or the
unique index sees two current claims and refuses the insert. But at the moment
the predecessor is updated the successor does not exist yet, so an
immediately-checked forward reference refuses the update instead. Either order
fails, and each failure looks like a bug in the other half.

Deferring resolves it without giving anything up: at commit both rows exist and
the reference is checked exactly as it would have been. The backward pointer,
`supersedes_verification_id`, is checked immediately like every other reference
in the schema, because the row it names is always already there.

This was found by a test rather than by design. The first implementation wrote
the two statements in the order that reads most naturally and failed on the
constraint it had just added.

### Supersession is recorded on the event that caused it

The `finding.verification_submitted` event for the new claim carries
`supersedes_verification_id`. There is no `finding.verification_superseded`
event.

`docs/EVENTS.md` §7 already settles this shape: an edited comment produces
another `*.comment_added` for the new revision carrying a back-reference,
because "an edit is an append with a back-reference, not a different kind of
occurrence". Supersession is the same. One act happened — a submission — and it
had a consequence for an earlier row. Emitting two events for it would let a
consumer see the consequence without the cause, and would put an ordering
question into the timeline that the single event does not have.

### Supersession under a pending human review, and what answers it

This decision leaves one case open, and RVP-89 is the report of it: a finding at
`AWAITING_HUMAN_REVIEW` may be superseded, and its status does not move. A
reviewer who has the comparison open is then looking at a claim that is no
longer current, and an accept that follows would land on evidence they were
never shown.

**ADR-0035 settles it, and this section exists so that a reader arriving here
does not have to find that out elsewhere.** The answer is neither of the two
this ADR's shape suggests. Returning the finding to `FIXED_UNVERIFIED` on
supersession would make the swap visible as a status change — it remains
available and nothing here excludes it — but it answers only *that* the
evidence changed and never *which* claim a human then accepted. Refusing a
submission while a review is pending would put an agent's ability to correct
its own work at the mercy of how long a person takes to look.

ADR-0035 instead makes the **decision name the claim**: a human disposition or
reopen carries the identifier of the verification the reviewer's comparison was
rendered from, and the control plane refuses one that is no longer current. The
identifier of a claim cannot be obtained by re-reading — a re-read returns the
new claim, which is refused from the other direction — so the client shape that
defeats a version check is closed as well. Accepting then marks that claim
`accepted` and reopening marks it `rejected`, which is what finally reaches the
`accepted` and `rejected` statuses `docs/DOMAIN_MODEL.md` §19 has always
declared.

Nothing in this ADR changes. Supersession stays exactly as decided above:
non-destructive, one current claim, recorded on the submission that caused it.
What ADR-0035 adds is that being current at the moment of a decision is now
something the decision has to assert rather than something a reader has to hope
for.

### The migration backfills before it constrains

Migration 0150 marks the older rows of every multi-submission finding
`superseded`, pointing each at the row that replaced it, and only then creates
the index. A Stage 0 installation may already hold exactly the shape the index
forbids, and an upgrade that failed on its own history would be an outage
produced by the fix. The backfill orders by `submitted_at DESC, id DESC`, so the
tie the old query could not resolve is resolved once, on the way past, and never
asked again.

## Consequences

### Positive

- "Which claim does this finding stand on" is a stored fact with one answer,
  read the same way by the viewer, the gate, the export and any future consumer.
- The record of what was claimed before, and shown before, survives every reopen
  cycle intact, which is what a human needs to judge a repeat claim.
- Two concurrent submissions cannot both become current, whatever the service
  layer does.
- A superseded row's forward pointer makes the chain walkable in either
  direction, so "what replaced this" is a lookup rather than a scan ordered by
  time.
- The upgrade path from Stage 0 is safe on data that predates the rule.

### Negative

- Verifications are never removed, so a finding reopened many times accumulates
  rows and the artefacts they reference are retained with them. That is the
  intent, and it makes verification history a subject for the Stage 2 retention
  work rather than something that quietly bounds itself.
- One constraint in the schema is deferred while its neighbours are immediate,
  which a reader will notice and must be told the reason for. The reason is in
  the migration beside the constraint.
- Every read path now filters on `status = 'submitted'` rather than taking the
  newest row, so a query written from memory of the old shape returns superseded
  claims. The check constraint that ties the status to the pointer columns is
  what stops the two disagreeing.
- Supersession is visible in the timeline only inside a submission event, so a
  consumer interested solely in supersession has to read a field rather than
  filter a type.

## Alternatives considered

- **Delete the previous verification.** One current row by construction, and it
  destroys the history `docs/DOMAIN_MODEL.md` §15 requires be preserved. It also
  removes the single most useful signal available to a human deciding whether to
  accept: that this claim has been made before.
- **Keep several current verifications and pick the newest by timestamp.** This
  is what the code already did. "The newest row" and "the current claim" are
  different questions that happen to share an answer for exactly as long as
  nothing supersedes anything — that is, until the first reopen, which is the
  case the feature exists for. Once they diverge the timestamp answer is a guess
  with a tie-break, and no stored fact contradicts it when it guesses wrong.
- **A separate `finding.verification_superseded` event.** Symmetrical and easy to
  filter, and it contradicts the precedent `docs/EVENTS.md` §7 sets for edited
  comments. It would also make a consumer reconcile two events describing one
  transaction, with the failure mode that seeing only the second reports a
  supersession with no visible replacement.
- **Enforce uniqueness only in the service layer.** The row lock is already
  there and would be sufficient for every path that takes it. The whole value of
  the constraint is against the path that does not, and that path is by
  definition the one nobody is thinking about when the code is written.

## Follow-up

- Retention for superseded verifications and their artefacts, with the Stage 2
  artefact-expiry work.
- ~~Surfacing the supersession chain in the review viewer, so a human sees that
  a claim is a repeat before deciding on it.~~ Done in RVP-55: the finding page
  lists every claim the finding has accumulated, states each one's status in
  words, and renders the comparison for any of them — and offers no decision
  while the comparison shows a claim that is not the one under review.
- Including superseded verifications in the portable export of
  `docs/REVIEW_FORMAT.md` in an order that makes the chain readable outside the
  product.

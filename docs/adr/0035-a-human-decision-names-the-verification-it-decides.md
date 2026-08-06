# ADR-0035: A human decision names the verification it decides

- Status: Accepted
- Date: 2026-08-06

## Context

The product's central promise is that a human accepts verified evidence. The
review workspace is where that happens: a reviewer opens a finding, reads the
agent's claim, looks at the before-and-after pair, and presses **Accept**.

Between the render and the press there is a window, and an agent can write in
it. ADR-0030 lets a second submission supersede the first: the earlier claim
becomes `superseded`, the new one becomes current, and the finding stays at
`AWAITING_HUMAN_REVIEW`. So the evidence under an open comparison can be
replaced with weaker evidence while the reviewer is reading it, and the accept
that follows would land on a claim nobody looked at. That is RVP-89.

Optimistic concurrency appears to close it, and nearly does.
`expected_version` is required on the disposition routes, and
`submitVerification` bumps the finding's version inside the locked supersession
path, so a swap moves the version and an accept carrying the version the
reviewer was shown is refused with `VERSION_CONFLICT`.
`apps/server/test/accept-evidence-integrity.test.ts` pins both halves of that.

It closes RVP-89 **only if the client sends the version it rendered from**, and
the client shape that breaks it is the natural one:

```text
load finding (version N) -> render comparison -> reviewer presses Accept
  -> client re-reads the finding "to get the current version" -> N+1
  -> sends expected_version N+1 -> 200 -> swapped evidence silently accepted
```

Nothing in the control plane can tell that request apart from a correct one. The
whole guarantee rests on a client not doing something reasonable-looking, which
is a convention rather than a control — and the surface where the convention has
to hold is the one surface the product exists for.

Separately, the audit trail had the same gap from the other side. Accept emitted
`finding.resolved`, carrying the disposition, the source, the deciding human and
the version — and **no reference to the evidence**. So even where the decision
was correct, the record could not say which claim a human had accepted, and
after an agent had submitted twice that is the only question worth asking.
`finding.verification_accepted` and `finding.verification_rejected` were declared
in `docs/EVENTS.md` and in the platform vocabulary with no emitter anywhere
(RVP-93), and `docs/API.md` §13 recorded acceptance and rejection of a
verification as unimplemented, arriving "with the review workspace UI".

## Decision

### A decision about a finding under review names the claim it is about

`finding_transition_request` and `finding_update_request` carry an optional
`verification_id`. It is **required** whenever the requested status is a final
disposition or `REOPENED` and the finding holds a current claim — a verification
whose status is `submitted`, which
`verifications_one_current_per_finding` makes at most one of.

- Naming none while one is pending is refused with `EVIDENCE_REQUIRED` and
  `details.field = "verification_id"`.
- Naming one that is not the current claim is refused with `VERSION_CONFLICT`,
  carrying `current_verification_id` and `expected_verification_id`.
- Naming one where the finding holds none is refused with `VERSION_CONFLICT`
  as well: a decision about a claim that is not there is not a decision the
  caller can have meant.

The refusal is `VERSION_CONFLICT` rather than a new code because, to the person
in front of it, it is the same event — the thing you were looking at changed —
and one recovery path is better than two that mean the same thing.

The check runs on the transaction that holds the finding's row lock, so a
submission racing a decision either completed before the lock, in which case the
identifier the decision names is no longer current and it is refused, or waits
for it. Reading the current claim outside the transaction would reintroduce the
window the check exists to close.

It is enforced in `ReviewService.updateFinding`, which every disposition path
funnels through, rather than on the three disposition routes. A rule placed on
the routes would be a property of those routes, and `PATCH
/api/v1/findings/:findingId` would be the way around it.

### The comparison is rendered from a named claim, not from "latest"

`GET /api/v1/findings/:findingId/verifications/:verificationId` serves one
verification with the assurance split of ADR-0031 and an `is_current` flag. The
review workspace renders the comparison from it, and carries that identifier
into the decision.

This is what makes the rule above a control rather than a second convention. A
client can only send an identifier it obtained, and the identifier of the claim
the reviewer was shown is not obtainable by re-reading: a re-read returns the
*new* claim, which the check refuses from the other direction. The defeating
client shape is therefore closed in the control plane, and the browser test in
`apps/web/test/ui/review-workspace.browser.test.ts` proves the client sends what
it rendered rather than what it just fetched.

### Accepting decides the claim; reopening rejects it

Accepting a finding moves the named verification to `accepted`; reopening moves
it to `rejected`. Both record `reviewed_at` and `reviewed_by_actor_type`, which
migration 0053 already constrains to `human_user` and migration 0153 now
constrains to carry a time. `docs/DOMAIN_MODEL.md` §19's `accepted` and
`rejected` statuses stop being reachable only in principle.

`WONT_FIX` and `DUPLICATE` decide neither. Waiving a reported problem is a
judgement about the report rather than about the claim made against it, and
recording it as an acceptance would put a human's name on evidence they did not
accept. They still name the claim, because the reviewer is still deciding about
a finding whose evidence could have been swapped underneath them.

A rejected or superseded record is **kept**. Nothing about a decision deletes
evidence, and `GET /api/v1/findings/:findingId/verifications` continues to serve
the whole history so a repeatedly-reopened finding does not read as a first
attempt.

### The two decision events are emitted, and they name the evidence

`finding.verification_accepted` and `finding.verification_rejected` are written
beside `finding.resolved` and `finding.reopened`. They carry the
`verification_id`, the actor that submitted the claim, the human who decided,
the finding's version after the decision, the accepted claim's after screenshot,
and the reason where there is one. Their payload schemas are in
`packages/protocol/schemas/review/v1.schema.json`, so a missing member fails the
`finding.*` decode assertion in `apps/server/test/review-lifecycle.test.ts`
rather than passing silently.

The events sit beside the disposition rather than instead of it, for the reason
`docs/EVENTS.md` §7 already gives: the status says the record moved, the
disposition says a human decided, and these say **what they decided about**.
Only the last survives an agent submitting different evidence afterwards.

### The version check stays

Both controls are kept. `expected_version` catches every concurrent change to
the finding, including ones that do not touch a verification; the pin catches
the one a refetching client would hide. Removing either because the other exists
would be removing a control on the argument that another control is holding,
which is how both come to be missing.

## Consequences

### Positive

- Accepting swapped evidence requires a client to name a claim it never
  rendered, which it has no way to obtain.
- The audit trail names the evidence a human accepted, so "which claim was this"
  is answerable after the fact rather than inferable from event ordering.
- RVP-89, RVP-93 and `docs/API.md` §13's unimplemented verification decision are
  one change rather than three.
- `verification_status`'s `accepted` and `rejected` members, and the
  `reviewed_at` / `reviewed_by` columns, stop being shape with nothing that
  reaches them.

### Negative

- It is a breaking change to the disposition routes for any client that already
  accepts a finding under review. Stage 1 has one such client and it is in this
  repository, but the compatibility statement of `docs/API.md` §20 has to record
  it.
- Two controls for one property is more to keep true than one, and a reader who
  finds the version check may conclude the pin is redundant. The argument for
  keeping both is in this ADR rather than in the code, which is a defence in
  wording.
- A finding whose claim was accepted holds no current claim, so a later reopen
  names none. That is correct — accepting decided it — but it means the rule
  reads as conditional at a call site, and a conditional rule is easier to get
  wrong than an unconditional one.
- `completionEvidenceFor` had to start treating an `accepted` claim as evidence.
  Without that, accepting would have made the completion gate report "resolved
  with no verification on record", which is the opposite of what happened.

## Alternatives considered

- **Rely on `expected_version` alone and forbid the refetch by convention.** It
  is what the code did. The convention is unenforceable from the server, the
  refetch is the natural thing to write, and the one surface it has to hold on
  is the acceptance decision.
- **Return the finding to `FIXED_UNVERIFIED` when a claim is superseded**
  (RVP-89 option 2). It would make the swap visible as a status change and is
  worth doing on its own merits, but it does not answer *which* claim was
  accepted, so it closes one of the two problems and leaves the trail as it was.
  It remains available and is not excluded by this decision.
- **Compare a digest of the rendered evidence rather than an identifier.** It
  would catch a claim edited in place as well. Nothing edits a verification in
  place — supersession is the only way a claim changes — so the digest would
  restate the identifier at more cost, and it would put the definition of "the
  evidence" in the client.
- **Record the accepted verification on the `findings` row instead of an
  event.** The verification row already carries its own decision, so a column on
  the finding would be a second copy of it, and the two would disagree the first
  time one was written without the other.

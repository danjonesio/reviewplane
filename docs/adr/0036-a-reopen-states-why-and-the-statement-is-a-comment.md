# ADR-0036: A reopen states why, and the statement is a comment

- Status: Accepted
- Date: 2026-08-06

## Context

`docs/UX_FLOWS.md` §13 has said "Requires a comment" under **Reopen** since it
was written. `docs/DOMAIN_MODEL.md` §15 says the same of `WONT_FIX`: "a reason.
Waiving a reported problem without one is not a decision anybody can review
later."

One of the two was enforced. `disposeFinding` refused a blank `WONT_FIX` reason
with `EVIDENCE_REQUIRED`. Reopen refused nothing: `finding_transition_request`
requires only `expected_version`, `reason` is optional, and `reopenFinding`
forwarded it when present. A reason-less reopen succeeded, and a review-level
reopen did too — `docs/API.md` §12 described `reason` on all four review
lifecycle routes as optional.

So the rule existed in the document and in the form the reviewer types into, and
nowhere else. That is the shape `docs/SECURITY.md` §7 names: a UI asking for a
field is never the control. A request that skips the form reopens a finding with
nothing said, and the agent that receives the inbox item is told to do the work
again with no account of what was wrong.

There is a second question underneath, which is what "comment" means. Where
`reason` was supplied it went onto the `finding.reopened` event payload and
nowhere else. `docs/API.md` §12 says so explicitly of the review routes:
"recorded on the event and never on the record". An event payload is not a
comment. It is not in the discussion `review_get` returns to an agent, it is not
in the finding's comment thread a human reads, and the whole purpose of
requiring the statement is that somebody has to act on it.

## Decision

### Reopen requires a reason, at the finding and at the review

`ReviewService.reopenFinding` and `ReviewService.reopenReview` refuse a missing
or whitespace-only reason with `EVIDENCE_REQUIRED` and
`details.field = "reason"`. `WONT_FIX` keeps the rule it already had, expressed
through the same function so the two cannot drift.

The check is in the domain rather than in the request schema, because one schema
body serves accept, reopen and wont-fix and accept legitimately carries no
reason. A rule that depends on which decision is being taken belongs where the
decision is known. Being in the domain also means it holds for any route that
reaches the same command, not only for the three that exist today.

The finding and the review are held to the same rule deliberately. They are the
same act at two scales, and a rule that held on one and not the other would make
the weaker one the route to use.

### The reason is written as a comment, on the same transaction

Every human disposition or reopen that carries a reason appends it as a comment
on the finding, in the transaction that records the decision. It is attributed
to the deciding actor by the ordinary rule of `docs/DOMAIN_MODEL.md` §18 —
derived from the authenticated actor, never supplied — so it appears in the
finding's thread exactly as a typed comment would, and an agent reading the
review sees what it has to act on.

One transaction, because the failure mode of two is the one combination that
makes the rule worse than not having it: a reopen that commits while the
statement of what is wrong does not.

The reason stays on the event as well. The event is the audit record and the
comment is the discussion; they answer different questions and an auditor should
not have to join a comment table to read a decision.

## Consequences

### Positive

- The rule two normative documents already stated is now true of the API rather
  than of the form.
- A reopened finding arrives at an agent with the reviewer's words in the place
  the agent already reads, rather than in an event stream it does not consume.
- `WONT_FIX` and reopen are held to one rule through one function, so the next
  disposition added inherits it rather than reimplementing it.

### Negative

- It is a breaking change for any caller that reopened without a reason. Inside
  this repository that was one test, which had nothing to say and now says
  something.
- A decision now writes a comment the caller did not explicitly ask for. That is
  the intent, but it means a client cannot reopen without also appending to the
  thread, and a caller that wanted the reason private has no such option. Stage
  1 has no private decisions.
- The comment is a second record of text that is also on the event, so an
  exporter that renders both will show it twice unless it knows they are one
  act.

## Alternatives considered

- **Require the reason in the request schema.** It would refuse before any
  handler ran, which is the stronger position. One body serves three routes with
  different rules, so expressing it would need either a discriminator property
  in the body — which `review_transition_request` deliberately avoids, so that a
  caller cannot ask one route for another's transition — or three request
  shapes. Neither is worth it for a rule the domain has to hold anyway, and the
  wire error would change from `EVIDENCE_REQUIRED` to `UNSUPPORTED_CAPABILITY`,
  which says the wrong thing about a reviewer who left a box empty.
- **Require a separate comment call before the reopen.** Two requests, either of
  which can succeed alone, which is exactly the split-brain the single
  transaction avoids.
- **Leave the reason on the event only and change `docs/UX_FLOWS.md` to say
  "reason".** Cheaper, and it would have made the documents agree. It answers
  the wrong question: the reviewer's words exist so that the agent can act on
  them, and an audit payload is not where an agent looks.

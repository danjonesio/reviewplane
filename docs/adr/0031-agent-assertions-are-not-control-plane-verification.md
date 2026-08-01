# ADR-0031: Agent-asserted checks are recorded as assertions, never as control-plane verification

- Status: Accepted
- Date: 2026-08-01

## Context

A verification carries a `checks` object with four members —
`reproduced_before`, `console_errors_reviewed`, `network_failures_reviewed` and
`accessibility_checked`. Every one of them is a statement by the actor
submitting it. Stage 1 captures no console log and no network artefact, so when
an agent reports `console_errors_reviewed: true` there is nothing in the control
plane to confirm it against, and nothing that would be different if the claim
were false.

Beside those four, the control plane really does check things before it records a
submission: that the artefact belongs to the project, that it came from a browser
session in this lineage, that its upload completed, that its digest matches, that
an after screenshot is present, and that the commit is not the one the finding
was captured at.

The completion gate of ADR-0029 reports evidence to an agent and, through the
review viewer, to a human. The question this ADR settles is whether those two
sets are reported as one set. Reporting them together is the natural thing to do
— they are all "checks performed on this claim", they arrive in one payload, and
a single list is a simpler shape.

It is also the exact confusion the product exists to remove. ReviewPlane's whole
claim is that a human sees verified evidence rather than an agent's assurance
that it did the work. A reader shown one undifferentiated list of checks, some
performed by this control plane and some asserted by the agent whose work is
under review, can only conclude that the control plane confirmed all of them.
That reader would then accept a finding on the strength of a machine agreeing
with itself.

## Decision

### Every response that reports evidence splits it in two

Responses carry an `evidence_assurance` shape with two separate lists:

- `verified_by_control_plane` — what this control plane checked for itself before
  recording the submission;
- `asserted_by_agent` — the members of the `checks` object that were true, each of
  which is the submitter's word and nothing more;

and `asserted_by`, naming the actor whose claims the second list holds.

Where nothing has been submitted, both lists are empty and `asserted_by` is
**absent**. An empty pair is a truthful answer; an `asserted_by` naming an actor
with no claims behind it would attribute something to somebody. Silence must not
read as confirmation in either direction.

### `verified_by_control_plane` names only what was actually checked

Its members are the checks performed in `ReviewService.submitVerification` before
the row was written: artefact project ownership, artefact browser-session
lineage, artefact upload completion, artefact integrity digest, the presence of an
after screenshot, that the commit differs from the one the finding was captured
at, and — **only where a workspace is registered** — that the branch matches it.

The last one is conditional and stays conditional. Where no workspace is
registered there is nothing to corroborate the branch against, so
`branch_matches_workspace` is absent from the list and the gate emits the warning
"branch not corroborated by a workspace" instead. An uncorroborated branch is a
qualification on the claim, not a check the control plane performed and passed.

### The two vocabularies are protocol data, and a test keeps them apart

`control_plane_verified_evidence` and `agent_asserted_evidence` are declared under
`x-protocol.vocabularies` in
`packages/protocol/schemas/mcp/v1.schema.json`, following ADR-0013: the rule's
content has one source and every consumer reads it rather than restating it.

A protocol test asserts that the reviewed checks appear in the asserted
vocabulary, that none of them appears in the verified one, and that the two sets
do not intersect at all. The gate therefore cannot present an agent's word as a
control-plane observation without the two lists first being made to overlap — a
change that fails a test whose failure message says what it means, rather than a
line moving quietly between two arrays.

### An unticked check is absent, not asserted false

`asserted_by_agent` holds only the members that were true. A check the agent did
not tick does not appear as a negative assertion, because the agent asserted
nothing about it. Where absence is worth reporting, it is reported as a warning
on the claim — "defect not reproduced first", "accessibility not checked" — which
is a statement about the evidence rather than a claim attributed to the actor.

## Consequences

### Positive

- A human reading a verification can tell, without knowing how the product is
  built, which statements the system stands behind and which are the agent's.
- The distinction is enforced by a test over protocol data rather than by the
  discipline of whoever next edits the gate.
- The lists are honest about Stage 1's actual reach: the console and network
  checks are visibly unconfirmed, which is both true and a legible argument for
  capturing those artefacts in Stage 2.
- When Stage 2 does capture them, the change is a member moving between two
  vocabularies and the checks it enables, not a change to how evidence is
  reported.
- Attribution travels with the claim, so a review that received submissions from
  more than one actor does not merge their assertions into one anonymous list.

### Negative

- Two lists are more for a client to render than one, and a client that renders
  only the first will show less than it could while a client that renders only
  the second will show an agent's claims with no counterweight. The shape is
  required, so this is a matter for the surfaces that consume it.
- Recording an agent's assertions at all is recording something unverified in a
  product about verification, and a careless reader may still take the second
  list as a finding of fact. The naming — `asserted_by_agent`, with the actor
  named beside it — is the whole defence, and it is a defence in wording.
- The vocabularies must be kept in step with what the service actually checks. A
  check added to `submitVerification` and not to the vocabulary would understate
  the control plane's assurance; the reverse would overstate it, which is worse
  and is the direction the overlap test does not catch.

## Alternatives considered

- **One flat list of checks performed.** Simplest for every consumer and it is
  the decision this ADR exists to refuse. It would let a reader conclude the
  control plane had confirmed an agent's word about its own work — which is
  precisely the confusion the product was built to remove, reintroduced in the
  one place a human makes the acceptance decision.
- **Drop the agent checks entirely until Stage 2 captures the artefacts.** It has
  a real argument behind it: recording an unverifiable claim is recording
  something the product cannot stand behind. They are still worth recording. A
  human deciding whether to accept needs to know whether the agent says it
  reproduced the defect before fixing it, because "this was broken and now is
  not" and "this looks right" are different claims and only the agent can say
  which one it is making. An assertion, labelled as an assertion and attributed,
  is information. Its absence is not neutrality; it just moves the same question
  into a comment thread where nothing is structured.
- **Trust the agent's checks as verification.** It would make the lists agree and
  the gate cheaper, and it would reduce the product's central guarantee to an
  agent marking its own work. There is no version of this that is compatible with
  `AGENTS.md`.

## Follow-up

- Stage 2 console and network capture moves `console_errors_reviewed` and
  `network_failures_reviewed` from `agent_asserted_evidence` to
  `control_plane_verified_evidence`, with the artefact checks that make the move
  true.
- The review viewer rendering the two lists distinctly, so the split reaches the
  human making the acceptance decision and not only the agent reading the gate.
- A check that the vocabularies match what `submitVerification` performs, so a
  check added to the service cannot be left out of the vocabulary it belongs to.

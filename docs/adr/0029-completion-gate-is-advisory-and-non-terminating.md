# ADR-0029: The completion gate reports and never decides, and never terminates the agent

- Status: Accepted
- Date: 2026-08-01

## Context

`AGENTS.md` and `docs/DESIGN_PRINCIPLES.md` §2 forbid a completion claim without
verification evidence, and `docs/MCP_SPEC.md` §7.8 named a completion gate that
would hold that line. Nothing implemented one. An agent could gather no evidence
at all, move a finding to `AWAITING_HUMAN_REVIEW` and report that it had
finished; the first thing to notice was a human opening the review and finding
nothing to look at. The rule was written in three documents and enforced in none,
and the transition it should have guarded —
`FIXED_UNVERIFIED -> AWAITING_HUMAN_REVIEW`, the hand-over itself — was legal
from the transition table of ADR-0024 with no evidence condition whatsoever, for
any actor.

Building the gate raised a question the documents do not settle: what a gate of
this kind is *for*. The obvious reading is that it decides whether work is done.
That reading is wrong here, and expensively so, because in this product the only
thing that decides whether work is done is a human accepting the review
(`docs/DOMAIN_MODEL.md` §15). A gate that decided would be a second authority
sitting beside the one the product exists to serve.

Two hazards were specific to this piece of work.

The first is the name. A tool called `task_complete` invites two misreadings: that
calling it makes something complete, and that its answer ends the agent's work.
Both are the kind of mistake an agent makes silently and a human discovers later
— the first as a review claiming completion nobody granted, the second as an
agent that stopped with findings left in `IN_PROGRESS` because it read a
correct answer as an instruction to halt.

The second was a divergence already sitting in the tree. `project_current`
advertised a `required_viewports` list out of a constant called `STAGE_0_POLICY`,
while the gate of §7.8 would judge submitted evidence against the project's
`default_validation_viewports` (`docs/DOMAIN_MODEL.md` §6). Each half was
individually defensible and together they were a trap: an operator who configured
a project's viewports would have had every agent told one requirement and judged
against another, with neither side reporting anything wrong. An agent that
believed what it was advertised would have been told to do the wrong work.

## Decision

### Two tools: one asks, one declares

`task_validation_status` reports what a review still requires and changes
nothing. It carries **no idempotency key**, because asking what is outstanding
alters no state, so asking twice is asking once and a key would only invite a
caller to believe otherwise.

`task_complete` evaluates the same thing and records its own evaluation as a
`review.completion_evaluated` event. It changes no review, no finding and no
verification. The only write it performs is the record that it was asked, which
is what separates the two: the first is a question an agent asks while working,
the second is a declaration, and a declaration is worth a line in the audit trail
whether or not the answer agrees with it.

### Four results, and no fifth

`task_complete` returns exactly one of `completed`, `completed_with_warnings`,
`blocked_missing_evidence` and `blocked_pending_review`. The enumeration contains
no member meaning terminated, stopped or aborted, so a server **cannot** report
termination whatever it believes; a protocol test asserts both that the list is
exactly those four and that no member matches `terminat|abort|stop|exit|kill`.

The response also carries `terminates_session: false` explicitly. Stating a field
that is always false is redundant everywhere except here, and here it is the
point: the tool's *name* is the one thing about it that could be misread, so the
response says in data what the enumeration already says by omission.

### `blocked_pending_review` is a correct answer, not a failure

It is what the gate returns when everything available to an agent is done and the
decision has passed to a human. An agent **MUST NOT** retry it and **MUST NOT**
attempt a further transition; there is no transition left that it may make. The
response says so directly in `next_actions` — "Wait for a human decision", "Do
not retry this call as though it had failed" — because a refusal that says only
what is wrong makes an agent guess, and a guessing agent retries.

This is the shape of the whole decision in one result. The most complete outcome
an agent can reach is a report that somebody else must now act.

### Requirements come from the project

`required_viewports` is rendered from the project's
`default_validation_viewports` (`docs/DOMAIN_MODEL.md` §6), read per request,
both where the gate judges and where `project_current` advertises. A project that
changes its viewports changes the gate rather than the gate holding a second copy
of a configurable rule.

The constant is now `STAGE_1_POLICY` and holds only the three product invariants
no project may vary: `agent_may_accept_findings: false`,
`verification_required: true` and `secret_tools_available: false`. Those are
constants because varying them would not configure the product, it would be a
different product. Anything an operator may legitimately set is read from the
project.

### The evidence gate binds `agent_session` actors only

The condition on `FIXED_UNVERIFIED -> AWAITING_HUMAN_REVIEW` applies where the
actor is an `agent_session`, and not where a human makes the same move. This is
the one deliberately narrow part of the decision and it should be argued rather
than assumed.

A human moving a finding to `AWAITING_HUMAN_REVIEW` is exercising the very
authority the gate defers to. Refusing a person's judgement about their own work
because a screenshot is missing would be the product overruling the human it is
built to serve, and it would do so on the strength of a checklist the same person
configured. The gate exists to stop an agent claiming completion it cannot
demonstrate; a human is not making a claim to be checked, they are making the
decision the claim is addressed to.

Nothing is weakened by this. Before this rule there was no gate on that
transition for anybody, so every actor gains a check or keeps none. The
asymmetry is worth revisiting in a later stage: where several people work in one
project, one person's undocumented hand-over is another's missing evidence, and
the honest version of that rule is a project policy rather than an actor-type
test. That belongs with the Stage 3 work on the finding transition table under
concurrent editing (RVP-7), not here.

### Only the hand-over is gated on a verification, and the first hop is not

RVP-53 scopes the evidence gate to two transitions:
`IN_PROGRESS -> FIXED_UNVERIFIED` **and**
`FIXED_UNVERIFIED -> AWAITING_HUMAN_REVIEW`. This decision gates the second on a
verification record and deliberately leaves the first gated only on a resolution
note, which is where RVP-37 left it. The divergence is recorded here rather than
left for a reader to discover, because an issue asserting a gate the code does
not have is this repository's most common defect.

The reason is circularity. `finding_submit_verification` is the call that
*creates* a verification, and submitting one is itself what moves an
`IN_PROGRESS` finding to `FIXED_UNVERIFIED`. An agent that takes the ordinary
path therefore arrives at `FIXED_UNVERIFIED` already carrying the record. The
only way to reach that status without one is the explicit
`finding_update_status` call — and gating *that* on a verification would make it
unreachable in every case where it is the caller's own next step, because
satisfying the condition performs the transition. The transition would remain in
`x-protocol.vocabularies.finding_status_transitions` and in
`docs/MCP_SPEC.md` §7.7 as one of the six an agent may request, while being
impossible to request successfully. Removing a documented capability by making
its precondition self-satisfying is a worse divergence than the one it fixes.

The evidence requirement is therefore **graduated** rather than absent, and both
hops refuse with `EVIDENCE_REQUIRED` when their own requirement is unmet:

| Transition | Evidence required |
|---|---|
| `IN_PROGRESS -> FIXED_UNVERIFIED` | a non-empty resolution note |
| `FIXED_UNVERIFIED -> AWAITING_HUMAN_REVIEW` | a current verification carrying the project's configured evidence |

That is defensible on its own terms and not merely convenient. `FIXED_UNVERIFIED`
is an agent's private working state — its name says the claim is *unverified* —
and nothing is asked of a human while a finding sits there. The hand-over is the
point at which the claim is made to a person, and it is the hop the exit
criterion is about. Gating the weaker status more strictly would buy nothing a
human ever sees.

What this does not do is let an agent reach a human without evidence, which is
the property that matters: `AWAITING_HUMAN_REVIEW` is unreachable for an
`agent_session` without a current verification, whichever route the finding took
to `FIXED_UNVERIFIED`.

### A refused hand-over is audited like every other refusal

A transition refused for missing evidence records `finding.status_change_denied`,
with the same payload and outside the same transaction as every other refused
transition (ADR-0024). `docs/DOMAIN_MODEL.md` §15 requires **every** refusal to be
audited, not only the authority ones.

This mattered because this repository has already shipped the opposite. The
denial path introduced with the transition tables captured its audit record after
the legality check, which was correct for the refusals it was written for and
left the majority of refusals unrecorded — including an agent that had claimed
the work asking to resolve it. A refusal nobody can see is indistinguishable from
an attempt nobody made, and the exit criterion is not "an agent cannot claim
completion without evidence" but "an agent cannot claim completion without
evidence **and the attempt is on the record**".

### Accessibility is recorded and never required

`accessibility_checked` is captured on every verification and is not a
requirement, so it never appears in a `missing` list. Where it is absent the gate
emits the warning "accessibility not checked", which is what
`completed_with_warnings` exists for: something a human should be told and that
nothing should be blocked on. Making it a requirement in Stage 1 would fail
correct work against a check the product cannot yet help an agent perform, and a
gate that rejects correct work gets routed around.

## Consequences

### Positive

- The invariant that no completion is claimed without evidence is enforced at
  the moment of the claim, in the layer that can explain what is missing, instead
  of discovered by a human at review time.
- One configured value drives both what an agent is told to do and what it is
  judged against, so the two cannot disagree.
- An agent that has finished everything available to it receives a named,
  correct, non-retryable answer rather than an error it will try again.
- Termination is structurally unavailable: there is no result an implementation
  could return, or a caller could parse, that means the agent should stop.
- Refusals of the new gate join the existing audit trail rather than forming a
  quieter parallel one.

### Negative

- `task_complete` writes an event for a call that changes nothing, so a review
  that is evaluated repeatedly accumulates rows. They are bounded by the agent's
  own calls and attributable to its session, and the alternative — a declaration
  with no trace — is worse.
- The gate reads project settings and the current verification on every
  evaluation, which is a read an agent can make as often as it likes.
  `task_validation_status` exists partly so that the cheap question does not have
  to be asked through the recorded one.
- The actor-type condition on the evidence gate is a rule with an exception, and
  exceptions are the parts of a rule people forget. It is invisible in the
  transition table, where the row reads `human_user`, `agent_session` either way.
  `docs/DOMAIN_MODEL.md` §15 **MUST** therefore state it beside the other
  authority rules, and a test **MUST** cover that a human may make the transition
  the same request refuses an agent. Neither is a detail the implementation may
  carry on its own.
- Four results are more for a client to handle than a boolean, and two of them
  differ only in whether a human must act next.

## Alternatives considered

- **A gate that terminates the agent process.** The tool's name suggests it and
  some agent frameworks expect it. It would put the decision to stop working in
  the hands of a control plane that cannot see what else the agent has been asked
  to do, and it would make a correct `blocked_pending_review` — the ordinary
  ending of a well-run task — indistinguishable from a fault. The control plane
  reports; the agent's own operator decides when it stops.
- **Block the transition for every actor, including humans.** Uniform, easier to
  explain, and it would let a checklist overrule the person whose judgement the
  entire review model is built on. The product would be refusing a human's
  decision about their own work on the grounds that a machine had not seen a
  screenshot.
- **Keep the requirements in a server constant.** That is what
  `STAGE_0_POLICY` did, and it is the divergence this ADR repairs. A constant is
  right for the three invariants no project may vary and wrong for anything an
  operator may configure.
- **Return a boolean.** `true`/`false` collapses the three distinct situations an
  agent must act on differently — evidence still to gather, a hand-over still to
  request, and nothing left to do but wait — into one bit, and the natural
  reading of `false` is failure, which is exactly the reading
  `blocked_pending_review` exists to prevent.

## Follow-up

- When Stage 2 captures console and network artefacts, two of the checks the gate
  currently reports as agent assertions become control-plane observations. The
  vocabularies of ADR-0031 are the place that changes, and the gate's own logic
  does not.
- Revisit the human exemption on `FIXED_UNVERIFIED -> AWAITING_HUMAN_REVIEW` with
  the concurrent-editing work of RVP-7, where a project policy is the right shape
  for it.
- `accessibility_check` becomes a project setting rather than a fixed `false`
  when the product can help an agent perform the check.

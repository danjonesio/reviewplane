# ADR-0028: Browser-command authority is derived from the authenticated actor, and the whole authorisation matrix runs in the control plane

- Status: Accepted
- Date: 2026-08-01

## Context

`docs/SECURITY.md` §7 lists six checks that must pass before a browser command
reaches Chromium: the session belongs to the actor's project; the session is
active; the actor owns the control lease or the command is a non-interactive
system capture; the control epoch matches; the command is permitted by policy;
and the target route is associated with the session. "Browser control commands
are project scoped" is a Stage 1 exit criterion.

The Stage 0 implementation ran two of the six in the control plane — session
state and control epoch — and delegated the rest, unevenly:

- **Project scope** was checked by *each caller*. The MCP screenshot tool
  compared the session's project against the agent session's; the HTTP route did
  not compare anything, because it was administrator-only. A rule that is a
  property of every caller rather than of the operation is a rule that a new
  caller can omit, and the exit criterion is about the operation.
- **Lease ownership** was checked only by the worker. The worker compares the
  *claimed* controller against its own state — so the check is satisfied by
  asserting the true controller's identity, and `CONTROL_NOT_OWNED` existed in
  the control plane only as a status mapping and a pass-through code. No
  control-plane path raised it.
- **Route association** was checked nowhere. The worker enforces the session's
  egress *origin*, but its policy is fixed when the context is created and
  `docs/SECURITY.md` §10 forbids widening it afterwards — so the worker cannot
  see that the route behind that origin has been revoked, has expired, or no
  longer names this session. Only the control plane can.
- **Policy** had no step at all, so `browser_type` had nothing that could refuse
  a secret, despite `docs/MCP_SPEC.md` §7.4 forbidding one and Stage 1 having no
  secret-injection tool to offer instead.

Underneath all of that sat a shape problem. `docs/API.md` §11 documents the
command request with `"controller": {"type": "agent", "id": "ags_..."}` in the
**body**. A body-supplied controller is a claim *about* the actor rather than
the actor, so the ownership check could be satisfied by naming its owner. Worse,
only one of the three denials in the command path wrote
`browser.command_rejected`: a stale epoch was audited, a wrong session status
and a missing worker were not. `docs/SECURITY.md` §8 requires stale commands to
be rejected **and logged**, and a denial that is correct and unrecorded is
indistinguishable from an attempt that never happened.

The lifecycle had gaps of the same kind. `PAUSED`, `TERMINATING` and `DEGRADED`
were in the status enumeration with no transition reaching them; there was no
`control/request` or `control/release`, so the epoch never incremented after
allocation and "every controller transition increments the epoch" was true only
because no transition existed; and `control_leases.expires_at` was written and
never read.

## Decision

### The matrix is one function, and it takes the actor's project

`modules/browser-sessions/authorisation.ts` holds all six checks as a pure
function over gathered facts. `BrowserSessionService.runCommand` takes
`projectId` — **the actor's project** — as a required argument and calls it.
There is no path to the worker that does not pass through it.

Making the project an argument rather than a caller's precondition is what turns
the exit criterion from a property of every call site into a property of the
operation. A caller that omitted it now fails to compile.

### The controller is derived, never claimed

`controller` is removed from the `POST /api/v1/browser-sessions/:id/commands`
body. The control plane derives the controller from the authenticated principal:
a human acts as the `system` controller bound to their session, and an agent
acts as `{ type: "agent", id: <agent session> }` derived from its credential.

A body that still carries `controller` is **refused** rather than ignored: a
caller that believes it chose the controller and did not is worse off than one
told the field is gone.

This is a breaking change to a documented request shape.
`docs/SECURITY.md` outranks `docs/API.md` in the precedence order and requires
the *actor* to own the lease, so `docs/API.md` §11 is corrected in the same
change rather than left inviting the impersonation.

`controller` remains accepted on **session creation**, where it names who
receives the initial lease. That is a legitimate choice by an administrator
allocating a session on an agent's behalf, and it is not a claim about who is
calling.

### The epoch is compared before lease ownership

Both refuse the same commands; the difference is which refusal a superseded
controller is told. A controller whose lease was taken holds a stale epoch *and*
no lease. `CONTROL_EPOCH_STALE` carries `details.current_epoch` and so tells the
caller what to do next; `CONTROL_NOT_OWNED` does not. It is also the order the
worker applies, and two layers that disagreed about which refusal a stale
command earns would make the audit record depend on which layer caught it.
`docs/SECURITY.md` §7 records the ordering and this reason, so the list is no
longer read as a required sequence.

### A lifecycle act obeys the same rule, and the rule is about where the inputs come from

`pause`, `resume`, `end` and `control/release` are authorised by the same
`#requireControl` the command path uses. What makes that guard real is that its
two authority inputs come from outside the record: the controller from the
authenticated principal, the epoch from the request body, where it is
**required** with no fallback.

This is stated as its own decision because the first implementation got it
wrong in a way that looked right. The four routes read `controller` from
`session.current_controller` and `control_epoch` from `session.control_epoch`,
and handed both to a check that compares them **against that same record**. The
guard was correct and unreachable: it compared the record to itself and admitted
any caller who could reach the route, catching only somebody who volunteered a
wrong epoch. The audit record was wrong in the same motion, naming the displaced
controller as the actor.

It also survived the test suite, which is the more useful lesson. The
service-level tests call `pause`/`end` directly and supply the controller and
the epoch — the two arguments HTTP never lets a caller choose — so they proved
the matrix and not the route, and the defect lived exactly in that gap. A
route-level suite driven over HTTP as a real signed-in human now exists
alongside them, and restoring the defect fails twelve of its nineteen tests.

**Reclaiming.** A human who needs to act on a session an agent holds takes
control first, as the `system` controller. That is not a bypass: the epoch
moves, the incumbent's in-flight commands are refused with
`CONTROL_EPOCH_STALE`, and `browser.control_transferred` records it. It is
strictly better than a lifecycle route that quietly acts in the incumbent's
name, and it needs nothing Stage 2 adds — takeover introduces *human interactive
input*, not the ability to hold a lease.

**Creation derives it too, and that is the whole surface.** `POST
/api/v1/projects/:projectId/browser-sessions` accepted a `controller` in its
body until the adversarial review. It is the weakest instance of this pattern —
no session exists yet, nothing is being seized, and the creator has authority
over what it creates — and it is included anyway, for two reasons. The first is
that a caller could name an identity it is not, so its own session's lease
belonged to somebody else: it could not end the session without taking control
first, while the slot counted against the worker's capacity. The second is that
nothing in the product sent it. The Live page does not, the end-to-end scenario
does not, and `browser_session_start` supplies an agent controller through the
**service**, derived from the credential rather than from a body. It was a test
affordance on the public surface — which is exactly how the four lifecycle
routes came to look reasonable.

`agent_session_id` remains the way to associate a session with an agent, and it
is a foreign key: a fabricated one is refused by the database. That a controller
identity carried no equivalent constraint is part of why it is derived rather
than accepted.

The rule is therefore uniform and can be stated in one line: **no route on this
surface accepts an actor identity in a request body.** A rule with one
documented exception is a rule nobody can apply without checking, and the
exception is where the next defect lives.

**`controller_id` is not accepted on `control/request`.** It let any project
member plant a lease owned by an identity that does not exist —
`ags_not_a_real_session` was enough — and revoke the incumbent's as a side
effect. It is the same claim-about-the-actor the command path already refuses;
this route had simply not been given the same treatment. `controller_type:
"agent"` is refused there too: an agent requests control under its own identity
through MCP, and a human doing it on an agent's behalf is one person acquiring
authority in another's name.

### Every denial is recorded

`browser.command_rejected` is written for **every** refusal in the command path and
in the lifecycle path — the latter with `kind: "lifecycle"` and `command` naming
the act, sharing one event type because the question an auditor asks is "did
anything try to act on this session and get refused?" and splitting the answer
across two types would let an auditor who checked one get a confident wrong
answer. The command-path denials are —
stale epoch, foreign project, non-owner, session not active, no worker,
unassociated route, policy denial — carrying the stable code, a reason token,
the presented epoch and the presented controller type. It never carries the
command's arguments: a refused `type_text` is exactly the command whose argument
must not enter an append-only table.

A **cross-project** attempt is recorded against the **actor's** project, never
the session's. Writing it to the session's stream would let a stranger append
rows to a timeline they cannot read, which is a worse outcome than the
enumeration the refusal already prevents. That record deliberately omits the
other project's epoch and status: the actor is not entitled to them, and the
refusal itself stays byte-identical to the one an unknown identifier earns.

### Pause is a control-plane gate, not a worker state

`PAUSED` suspends **interactive** commands and admits non-interactive system
capture, exactly as `docs/MCP_SPEC.md` §7.3 describes. The worker is not told:
the lifecycle belongs to the control plane (`docs/DOMAIN_MODEL.md` §12), and a
worker that also held a pause flag would be a second answer to whether a command
may run. The context stays open and live frames keep flowing, so "pause and look
at it" is a usable act rather than a blackout.

Resuming returns the session to `READY` rather than `ACTIVE`: a resumed session
has been sitting and the page may have moved, and `READY` is the state a fresh
snapshot is taken from.

### Control transfer increments the epoch, in one transaction

`control/request` revokes the outstanding lease, writes the new one and
increments `browser_sessions.control_epoch` in a single transaction, so a lease
can never exist at an epoch the session does not carry. `control/release` also
increments: after a release nobody holds the lease, and a command still carrying
the released epoch would otherwise pass the epoch check and be refused only by
the weaker ownership check.

Re-requesting control the caller already holds is **idempotent and does not
increment** — `docs/TESTING.md` §5 requires duplicate control commands to be
idempotent, and an increment there would refuse every command the caller had
already prepared.

`controller_type: "human"` is refused with `UNSUPPORTED_CAPABILITY`, and the
refused request is still audited as `browser.control_requested` with
`granted: false`. Takeover is Stage 2 (`docs/ROADMAP.md`); the epoch model is
already correct, so Stage 2 adds a controller rather than reworking it.

### Secret material is refused by shape, and the refusal names no value

`browser_type` / the `type_text` command is refused with `POLICY_DENIED` when
its text matches a known credential shape — a `rpa_` agent token, a bearer
header pasted whole, a PEM private-key block, an AWS or GitHub key, or a
`password=`/`api_key=`-style assignment. The refusal reports *which shape*
matched and never the value.

Shape detection is a heuristic and is stated as one: it catches the forms a
credential actually arrives in and cannot catch a password that looks like a
word. Stage 1 has no secret store and no injection tool, so there is no
supported way to type a credential into a page at all; this is a guard rail on
that rule, not a substitute for it.

A **capacity** refusal is not recorded, deliberately.
`BROWSER_CAPACITY_EXHAUSTED` is a scheduling outcome rather than an authority
denial: no session exists to correlate a record to, nobody was refused an
authority they might have held, and `browser_worker.degraded` /
`browser_worker.lost` plus `reviewplane status` already say *why* there was no
capacity. Recording one per attempt would also let a client retrying in a loop
write to an append-only table at request rate.

## Consequences

### Positive

- All six `docs/SECURITY.md` §7 checks run before the command leaves the control
  plane, so the exit criterion is met at the layer it names rather than at the
  worker.
- Authority cannot be asserted by a request body.
- Every refusal leaves a record, so "did anything try to drive that session?" has
  an answer.
- Route revocation takes effect on the next navigation rather than at session
  end.
- The lifecycle states that existed only in an enumeration now have transitions,
  and leases expire.

### Negative

- **Breaking API change.** A client sending `controller` on a command is now
  refused, `controller_id` on `control/request` is refused, and `control_epoch`
  is required on all four lifecycle routes rather than defaulted. The MCP surface is unaffected (it never exposed the field) and the
  in-repo callers are updated, but an external script written against
  `docs/API.md` §11 will break, loudly, on its next call.
- Route association costs one query per navigation. It is an indexed primary-key
  read and only navigation pays it, but it is on the hot path.
- Recording every denial makes a refusal a write. A caller retrying a stale
  epoch in a loop now writes an event per attempt; the rate limits of
  `docs/API.md` §19 are the bound on that, and they are not tuned for it.
- The secret-shape check reads the typed text in the control plane. It is not
  logged, not echoed and not stored, but it is inspected — a deployment that
  wanted the control plane never to see typed text cannot have that and this
  check at once.
- Pause is invisible to the worker, so a worker restarted mid-pause has no
  memory of it. The control plane is authoritative and re-refuses, so the
  outcome is right; the worker's view is simply less complete than the control
  plane's, which is the intended asymmetry.

## Alternatives considered

**Leave the checks distributed and test each caller.** Rejected: it is what
Stage 0 did, and the two callers disagreed. The exit criterion is about
commands, not about callers.

**Keep `controller` in the body and validate it against the principal.**
Equivalent when correct, and it keeps a field whose only purpose is to be
checked against something the server already knows. A field that must equal a
derived value is a field that will eventually be trusted instead of compared.

**Make pause a worker-side flag.** Rejected: two authorities for one question.
The failure mode is a session the control plane thinks is running and the worker
refuses, or the reverse, with no way to tell which is right.

**Refuse secrets in the MCP layer only.** Rejected: the HTTP command route can
type text too, and a rule enforced on one of two paths is a rule with a
documented bypass.

**Compare lease ownership only on the worker (the Stage 0 behaviour).**
Rejected: the worker compares the claimed controller against its own state, so
the check is satisfied by asserting the true controller's identity. A
worker-side-only refusal produces the right-looking outcome while failing the
criterion "authorised before reaching Chromium", and the test for it must assert
that the worker received **no request** rather than merely that the caller got a
non-2xx.

## Follow-up

- `docs/API.md` §11 loses `controller` from the command example and gains the
  pause, resume, control and timeline endpoints.
- `docs/SECURITY.md` §7 records the check ordering and the reason; §8 records
  lease expiry and the idempotency rule; §12 records the secret-shape guard rail
  and its limits.
- `docs/MCP_SPEC.md` §7.3 and §7.4 record the tools and their capabilities.
- `docs/DOMAIN_MODEL.md` §12 and §13 record what the pause and the epoch mean.
- Stage 2 (RVP-25) adds the `human` controller to `control/request`; nothing in
  this ADR changes when it does.

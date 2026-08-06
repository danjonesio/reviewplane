# UX Flows

## 1. UX objective

The web application is the visual review and supervision surface. The CLI agent remains text-first. The system should make context transfer between them deliberate, durable and low-friction.

## 2. Navigation model

Primary navigation:

```text
Home
Projects
Live sessions
Reviews
Connectors
Artefacts
Administration
```

Within a project:

```text
Overview
Live
Reviews
Environments
Policies
Settings
```

The first release may hide unavailable team and policy surfaces while preserving the information architecture.

### 2.1 What the application implements today

Primary navigation: **Live sessions**, **Projects**, **Reviews**, a **project
switcher** and the signed-in account with **Sign out**. Home, Connectors,
Artefacts and Administration are not separate surfaces yet: connectors and
artefacts are reached through the project that owns them, and administration has
nothing in it while the deployment has one account.

Within a project: **Overview**, **Live**, **Reviews**, **Environments**,
**Settings**. Policies is hidden, as this section permits, because
`docs/DOMAIN_MODEL.md` section 22 defers policy records to Stage 4. It keeps its
documented position between Environments and Settings, so adding it later is a
tab rather than a redesign.

The project switcher is a native `<select>`. It is reachable and operable by
keyboard on every platform without custom key handling, it is announced
correctly by screen readers, and on a 390px viewport the platform supplies a
usable picker for it.

Navigation reflects authorisation and never grants it: every surface reads
through a project-scoped API, and a session that may not see a project is
refused by the control plane whether or not a link to it was rendered
(`docs/SECURITY.md` section 7).

## 2.2 First run

An installation that has no administrator answers the first screen with **Set up
this installation**: the one-time token from `reviewplane install-token`, the
email address to create, and the password. A claimed installation answers with
**Sign in**: email address and password. Both are the same screen, because for
the person in front of it they are the same moment.

The refusal of a sign-in is an `alert` region naming what to do, never a field
that echoes what was typed, and it is the same message whichever part was wrong
(`docs/SECURITY.md` section 6.1).

## 3. Fleet dashboard

Purpose: answer "what are my agents and browsers doing now?"

Each active-session card shows:

- Project
- Agent type and session
- Development environment
- Branch and dirty state
- Current task summary
- Live browser thumbnail
- Current route and viewport
- Status: active, waiting, blocked, paused, disconnected
- Pending review or approval count
- Last meaningful event

Actions:

- Open session
- Pause agent browser input
- Take control
- Create review from latest frame
- End browser session

Do not autoplay high-frame-rate streams for every card. Thumbnails use a low frame rate and stop when off screen.

### 3.1 What the shipped dashboard does

Every fact above is on the card. Two of them are stated as absences rather than
omitted, because a card that quietly drops a row a reader was told to expect
looks complete and is not:

- **Agent type and session** is read from the browser session's current
  controller. When an agent session holds the browser the card names it; when
  nothing does, the card says "no controller holds this browser". Stage 1 humans
  act through the `system` controller, so that is what a human-started session
  shows.
- **Current task summary** has no domain object behind it at this stage. The
  card shows the newest **agent action** from the event record instead, labelled
  as that, and says so when there is none.

**Status** is the five words of this section — active, waiting, blocked, paused,
disconnected — derived from the nine browser-session statuses of
`DOMAIN_MODEL.md` §12. The mapping is: `REQUESTED` and `ALLOCATING` are
*waiting*; `READY` and `ACTIVE` are *active*; `PAUSED` is *paused*; `FAILED` is
*blocked*, because it can go no further without a person; `DEGRADED`,
`TERMINATING` and `TERMINATED` are *disconnected*. A status the web application
does not recognise is reported as *disconnected* and never as a healthy one. The
card also states the domain status beside the summary word, so the difference
between a session that ended and a worker that stopped reporting is not lost in
the summary. Each of the five carries its own word **and** its own shape, so the
statuses remain distinguishable in greyscale.

**Environment, branch and dirty state** come from the route the session reaches
its application through: the published route names a workspace, and the
environment that reported that workspace is the one the card names. Deriving it
from the project instead would name the wrong machine whenever a project has two.

Actions on the shipped card are **Open session**, **Pause agent browser input**,
**Create review from latest frame** and **End browser session**.

**Take control is not offered.** It belongs to human takeover of §8, which is a
later stage: there is no control channel, no pointer or keyboard input and no
"you are controlling this browser" state. An affordance that could not take
control would leave a reader believing they hold input authority they do not
have, so the dashboard states in words that watching is read-only rather than
leaving the absence of a button to imply it.

**Create review from latest frame** is the entry point and not yet the act.
Naming a review captures the branch, commit and checkout it is interpreted
against (`API.md` §13), which the annotation-capture flow supplies; the card
therefore opens the session room at its capture section, which says what is
available and what is still to arrive.

## 4. Project creation

### Flow

1. User selects **New project**.
2. Enters project name and repository identity.
3. Selects default branch.
4. Chooses default validation viewports.
5. Saves project.
6. UI displays connector enrolment instructions.

### Validation

- Repository identity is normalised
- Project slug is unique in organisation
- Default viewport values are bounded

### Implemented behaviour

The form takes the project name, an optional repository clone URL, the default
branch and the default validation viewports as checkboxes, defaulting to 390x844
and 1440x900. It previews the address the name will produce while it is typed.

Validation is the control plane's. The form previews an outcome; it does not
decide one, because a second implementation of the rules would eventually
disagree with the one that enforces them. A refused save is an `alert` naming
the field, and the form keeps what was typed.

Saving leads to the connector enrolment instructions rather than to a list: a
project with no environment cannot do anything yet, and the command that gives
it one is the next thing the person needs. The same instructions live on the
project's Environments tab.

## 5. Connector enrolment

Enrolment lives inside the project that owns the environment (§2.1), not in a
primary navigation entry of its own. Three surfaces: what is connected and how
healthy it is; minting a token and watching the machine arrive; and one
connector's whole record.

### UI

Display:

- One-time enrolment command
- Expiry
- Project scope
- Expected environment labels
- Security warning that the token is shown once

Example:

```bash
sudo reviewplane-connector enrol \
  --control-plane https://agents.example.internal \
  --token-file /root/reviewplane-enrolment-token
```

The screen MUST display the command the control plane assembled
(`API.md` §9) rather than one composed in the browser, so that every surface
shows the same command and none of them can drift from what the binary accepts.
It reads the token from a file rather than from the command line, because a
command line is in the process table and in shell history
(`CONNECTOR_PROTOCOL.md` §20).

The shown-once warning MUST be visible without scrolling and MUST say why:
the control plane stores only a digest, so no administrator and no support
request can produce the token a second time, and a lost one is replaced by
minting another rather than recovered.

Getting the command out of the page MUST work without a clipboard. A copy button
is not sufficient on its own — not every browser exposes the clipboard, and one
that does may refuse the write, neither of which is the reader's mistake. The
command block MUST therefore be focusable and selectable with a visible focus
indicator, and a refused clipboard MUST fall back to selecting it and saying so
in words. A page whose only route out was a clipboard the browser declined would
be a page a keyboard user could not finish.

### Completion

Enrolment happens on another machine, so completion arrives as a change in the
connector list rather than as an answer to a request: the screen updates on its
own and says so, and nothing needs refreshing.

It reports:

- Environment name
- Version
- Platform
- Connection health
- Detected authorised workspace

These five MUST be announced in a polite live region, as one sentence rather
than as five fields, because a live region is read aloud rather than scanned. A
connector that was already active when the page opened MUST NOT be announced as
having just enrolled: only an identity that appeared after the page was opened
is a completion of *this* flow.

Connection health is a sentence, not a colour: the status word carries a badge,
and the sentence says what the word means — waiting for the connector to dial
out, connected and answering heartbeats, connected but heartbeats are late, or
no heartbeat and no open channel (§19).

The detected workspace names the checkout directory and the branch it is on. A
project may legitimately have none yet — the connector reports only explicitly
configured paths (`CONNECTOR_PROTOCOL.md` §9) — and the screen MUST say so
plainly rather than leaving the field blank.

Everything on these screens was reported by another machine. It is description,
never an authorisation input, and it MUST be rendered as text rather than as
anything the reporting machine could aim (ADR-0010).

### Revocation

Revoking a connector is terminal — a revoked identity is refused before a channel
is established, and re-enrolment creates a new one — so it MUST be a deliberate
two-step action whose confirmation states those consequences in words rather
than relying on a red button to imply them.

The outcome MUST report what the revocation actually reached: routes revoked,
sessions degraded and channels closed (`API.md` §9). It MUST be announced in the
live region as well as shown in the list, so that a person who cannot see the
list change still learns what revoking did.

## 6. Start browser session

Entry points:

- Agent MCP request
- Project live page
- Published service action

Publication itself lives on the project Live page. The reader chooses an
environment, a workspace and a local port, sets a lifetime, publishes, sees the
route's status and internal origin, and revokes it. A route MUST authorise at
least one browser session (`CONNECTOR_PROTOCOL.md` §11), so the form names the
sessions it will authorise; a project with none says so in those terms rather
than failing on submit.

Human flow:

1. Select development environment and service.
2. Choose viewport preset.
3. Choose trace and optional video policy.
4. Start session.
5. Open session room.

The UI should clearly show that Chromium runs centrally and the application is reached through a private connector route.

Stage 1 implements steps 1, 2, 4 and 5. Step 3 is **disclosed and disabled**:
trace capture arrives in Stage 2 and video stays disabled, so the control states
that neither is available in this stage rather than offering a choice the
product cannot honour or omitting the step silently.

The viewport presets MUST include **1440x900** and **390x844**, which is what
`AGENTS.md` requires browser-facing work to be validated at; the rest come from
the project's default validation viewports.

Starting a session is a state-changing act a **project-scoped human session** may
perform, not only an administrator (`API.md` §11). It is a live browser opened
against a private development machine, so the request carries the session's CSRF
token like every other state-changing write.

The service selector offers "no published service" explicitly rather than
leaving the control blank. A session with no route reaches nothing, and that is a
choice a reader may legitimately make — for the reservation-first ordering of
`API.md` §11, where the session identifier must exist before the route that
authorises it can be published.

## 7. Session room

Recommended layout:

```text
┌──────────────────────────────────────────────────────────────┐
│ Project / Agent / Branch / Status      Pause  Take control   │
├───────────────────────────────────┬──────────────────────────┤
│                                   │ Activity                 │
│           Live browser            │ Agent actions            │
│                                   │ Findings                 │
│                                   │ Approvals                │
│                                   │ Comments                 │
├───────────────────────────────────┴──────────────────────────┤
│ Console | Network | Git | Screenshots | Trace | Session data │
└──────────────────────────────────────────────────────────────┘
```

### What the shipped room does

```text
┌──────────────────────────────────────────────────────────────┐
│ Project / Agent / Branch / Status                    Pause   │
├───────────────────────────────────┬──────────────────────────┤
│           Live browser            │ Activity                 │
├───────────────────────────────────┴──────────────────────────┤
│            Git | Screenshots | Session data                  │
└──────────────────────────────────────────────────────────────┘
```

The header states project, agent, environment, branch, dirty state, current
route, viewport, status, current controller and control epoch. The browser
surface is beside the **Activity** panel at desktop widths and above it at 390px,
because at one column the picture is what the reader opened the page for.

**Activity** renders the project event stream (`API.md` §18.1) narrowed to this
session by the `browser_session_id` correlation, grouped as agent actions,
findings and comments, newest first. It seeds from
`GET /api/v1/projects/:projectId/activity`, resumes the socket from the last
sequence it applied, and refetches when the control plane answers
`stream.refresh_required` — the refresh is stated to the reader rather than
applied silently, because a history with an invisible gap is worse than one that
says it was re-read. The panel is bounded; the durable record holds the rest.

Only members the web application names are rendered from an event payload, and a
member that came from the rendered page is marked as page-derived beside its
value. Redaction is already applied when an event is written (`EVENTS.md` §6);
the allow-list is the second lock, so a payload member added later cannot reach
this surface by default.

**Take control is absent**, for the reason given in §3.1: takeover is a later
stage, and the controller is therefore displayed read-only and labelled as such.
The room states in words that watching this browser does not drive it, and that
Pause, Resume and End act on the session rather than on the page.

**Console, Network, Trace and Approvals are absent rather than empty.** §18
forbids showing a panel as empty without explanation, so the tab strip carries
only the three that have something in them and a sentence beside it names the
others and when they arrive.

The **Screenshots** tab lists what was explicitly captured. A live frame is not
a screenshot and never becomes one (ADR-0009), which the empty state says, so a
reader does not conclude that a recording failed.

### Browser surface overlays

- Agent pointer: blue
- Agent intended target: green outline
- Human pointer: yellow
- Existing findings: purple markers
- Policy-blocked action: red
- Selected annotation: accessible high-contrast outline

Colours must not be the only means of identification. Every overlay therefore
carries a **shape**, a **short label rendered as text** and an **accessible
name**, and the colour is the fourth thing rather than the first. The marks are
drawn in a layer above the canvas and never painted into it: a frame is a live
rendering of another application, and nothing may modify or retain it (ADR-0009,
ADR-0010). Geometry is normalised — a fraction of the frame — so a mark lands in
the same place after a resize, a scroll or a device-pixel-ratio change.

A list of the same overlays as text sits beside the surface and is the
authoritative rendering: it is the non-canvas alternative §19 requires, and it
is the only place an overlay with no position can appear at all.

Agent pointer and intended target are **reserved in the live protocol and not
sent** (`API.md` §18.2), so nothing populates them at this stage and the list
says so rather than showing an empty region. Human pointer and selected
annotation belong to takeover and to the annotation canvas respectively. What can
appear today is an action policy refused, which is recorded as
`browser.command_rejected`.

## 8. Human takeover

### Start

1. Human selects **Take control**.
2. Confirmation explains that agent input will pause.
3. Control plane requests a lease.
4. Agent input is revoked.
5. UI displays `You are controlling this browser` and epoch status.

### During control

- Keyboard and pointer input sent through control WebSocket
- Agent activity panel indicates waiting for human
- Human can capture screenshot or create finding
- A visible release button remains available

### Release

1. Human selects **Return control**.
2. System freezes input briefly.
3. Captures screenshot, URL and accessibility snapshot.
4. Records optional handoff comment.
5. Transfers lease to agent.
6. Agent receives inbox or MCP state change.

Unexpected disconnect causes a short grace period and then safe release to `none`, not immediate agent resumption unless policy permits.

## 9. Create annotated finding

### From live view

1. Select **Annotate**.
2. Choose rectangle, ellipse, arrow or marker.
3. Draw over browser content.
4. Add title and comment.
5. Choose severity.
6. Optionally add acceptance criteria.
7. UI resolves the best DOM element under the geometry.
8. Save as draft finding.

### Required captured context

- Screenshot
- URL
- Viewport
- Device-pixel ratio
- Scroll position
- Annotation geometry
- Element context if available
- Project branch and commit
- Source session

### Implemented behaviour

The flow lives in the session room, under **Annotate this session and create a
review** (`apps/web/src/components/CaptureFinding.tsx`). Six differences from
the list above, each of them a decision rather than an omission.

**The evidence is captured first, and the mark is drawn on it.** Selecting
Annotate takes a screenshot and an accessibility snapshot in the same moment,
through `take_screenshot` and `snapshot` — both **non-interactive system
captures**, which a person watching a session may issue without holding the
interactive control lease (`docs/SECURITY.md` §7). That is what makes annotating
a live application possible in a stage with no human takeover. The capture is a
**viewport** screenshot rather than a full-page one: geometry is normalised to
the artefact's content rectangle, and a viewport capture's content rectangle is
the frame the human was looking at, scaled by the device pixel ratio.

**Both captures report the page's scroll offset, and the flow records what they
reported.** A viewport capture is a picture of one screenful, and the offset is
what says which screenful; the surface MUST NOT substitute the origin for it. A
finding captured from a scrolled page with the offset recorded as `{0, 0}`
resolves its element context against the top of the document rather than
against what the human was looking at (ADR-0033), and the value is the one thing
`docs/DOMAIN_MODEL.md` §15 says a viewport-sized screenshot cannot be placed
back on its page without.

**A capture whose upload did not complete is not annotated.** The flow reads the
artefact back and requires `available` before it offers a canvas, so the
"Evidence upload incomplete" state of §18 is reached instead of a draft finding
built on unverified bytes.

**All six types of `docs/DOMAIN_MODEL.md` §16 are offered**, not the four the
list names: rectangle, ellipse, arrow, point, numbered marker and freehand.

**The keyboard is a route to every one of them but freehand.** The canvas is
focusable; arrow keys move a cursor, Enter fixes a corner and then the shape,
Shift gives a finer step and Escape abandons a mark in progress. The cursor's
position is stated as a percentage, so it is knowable and not only visible.
Freehand is a gesture, and rather than simulate one the surface says so and
names the shape that marks the same region.

**Element context is resolved from the snapshot taken with the picture**, by the
rule of `docs/DOMAIN_MODEL.md` §17 — the smallest element containing the centre
of the first mark. Where nothing is resolved the surface says so and the finding
is stored without it, because §9 calls this context best effort and an invented
element is worse than none. Where something is resolved, the surface states that
it came from the page and is not an instruction.

**A draft finding is held in the browser tab, not on the server.** A finding
belongs to a review, and §10 groups drafts into one, so there is no review to
attach the first draft to until it has been named. Drafts are mirrored into
session storage so a reload recovers them, and the surface says plainly that
nothing has been saved yet rather than implying that it has.

Nothing drawn here reaches the page under review. The canvas sits over a
picture — a still capture, or a frame this application renders and never drives
— and the room's statement that watching is not driving stays true.

## 10. Create named review

Draft findings can be grouped.

Form:

```text
Title: Bugs on homepage
Slug: bugs-on-homepage
Project: Refresh Surplus
Priority: High
Assign to: Current agent session
Instruction: Fix these before continuing with the product page.
```

Actions:

- Save draft
- Mark ready
- Assign
- Copy CLI command
- Send inbox item

Example CLI guidance:

```text
Review and resolve control-plane review "bugs-on-homepage".
```

### Implemented behaviour

The form appears under the draft findings once there is at least one, and
carries every field above. Four things about it are decisions:

**The slug is previewed and never validated here.** The field shows what will be
sent — the title, lowercased and hyphenated — and the control plane decides
whether it is acceptable. A second implementation of the rules would eventually
disagree with the one that enforces them. A slug already held by an active
review of the project is refused with `IDEMPOTENCY_CONFLICT`, and the surface
names the action: choose another, or archive the review holding it. **The drafts
survive that refusal**, because a collision is a rename rather than a loss.

**Save draft and Mark ready are the two submits**, creating the review `DRAFT`
or `READY` and then creating each finding with its annotations in one request.
The form mints one idempotency key when it opens and reuses it, so a double tap
produces one review and one set of findings rather than two.

**Assignment takes an agent-session identifier by hand.** No endpoint lists a
project's agent sessions yet, so a chooser here would be a list this surface had
invented. The field states that, and leaving it blank creates the review
unassigned.

**Send inbox item is not a separate control.** An inbox item is what assignment
causes (`docs/DOMAIN_MODEL.md` §21); a second button that claimed to send one
would either duplicate the assignment or do nothing.

The copyable command is the documented sentence, quoting the slug. §11's
prohibition is on a claim, so the surface makes the opposite claim explicitly:
it states that ReviewPlane does not type into an agent's terminal and that
nothing reaches the agent until the reader runs the command there. A browser
that offers no clipboard gets a disabled control and the keyboard route rather
than a thrown error.

## 11. CLI retrieval

The web UI should show current agent delivery state:

```text
Assigned to Claude Code session ags_...
Inbox: pending
Agent acknowledgement: not yet received
```

When fetched:

```text
Inbox acknowledged 11:34
Review claimed 11:35
Finding 1 in progress
```

Do not claim that the control plane has injected text into the terminal unless a managed adapter actually supports it.

### Implemented behaviour

The review page carries an **Agent delivery** section between the review's facts
and its findings (`apps/web/src/components/AgentDelivery.tsx`). It states three
things and derives none of them from another, because each answers a different
question and the wrong inference is the confident one:

- **Assigned to** — `assigned_agent_session_id`, or failing that
  `assigned_user_id`, as the identifier the control plane holds. No endpoint
  resolves an agent session to a client's name, so the surface MUST render the
  identifier and MUST NOT print a client name it inferred. Where neither member
  is set, the cell says "Not assigned".
- **Inbox** — the status of the inbox item carrying this review, read from
  `GET /api/v1/projects/:projectId/inbox` (`API.md` §16) and matched on
  `review_id`. All five statuses are requested explicitly, because the endpoint
  answers with the live ones alone when none is named and a completed or
  dismissed delivery would otherwise be indistinguishable from one that never
  happened. The status is a word beside its badge and never a colour alone.
  Where no item carries the review, the cell says "No inbox item".
- **Agent acknowledgement** — "not yet received" until the item carries an
  `acknowledged_at`, and that time once it does. It is read from the timestamp
  and never from the status, because an item may be completed by a recipient
  that never acknowledged it (`DOMAIN_MODEL.md` §21) and "not yet received" is
  then the true reading rather than the tidy one.

Where the review is assigned to nobody and no item carries it, the section
renders one named empty state in place of the three cells. Three absences
presented as three cells would read as a delivery state, which is exactly the
claim there is no evidence for.

The per-finding half of §12 is on the finding card: a **Worked by** cell states
`claimed_by`'s actor type and identifier, or "Nobody". The finding's own status
is already on the card beside its severity. Nothing records the time a review
was claimed — the review entity carries no such member — and there is no
per-finding progress beyond the finding's status, so the surface states neither
rather than assembling the second block of this section out of values it does
not have.

Nothing on this surface injects anything anywhere, and it says so rather than
leaving the reader to assume: the copy control of §15 is accompanied by the
statement that ReviewPlane does not type into an agent's terminal and that
nothing reaches the agent until the reader runs the command there.

## 12. Agent finding workflow in UI

Finding card displays:

- Before screenshot with annotation
- Human comment
- Source viewport and URL
- Captured branch and commit
- Current staleness state
- Assigned actor
- Activity timeline
- Verification section

Statuses must be readable and not rely on colour alone.

### Implemented behaviour

The review list, the review page and the finding page are three surfaces rather
than one. A review with several findings, each carrying a before-and-after pair
and a decision, is not a page anybody can read at 390 pixels, and a decision
deserves an address that can be linked to and returned to.

- `/reviews` lists reviews and carries the search of §16.
- `/reviews/:reviewId` states the review's facts, its agent delivery, the
  review-level decision, the discussion, and each finding in summary.
- `/reviews/:reviewId/findings/:findingId` is the finding card of this section
  and the verification review of §13, and it is where a human decision is taken.

Every status is a word beside its badge **and a sentence saying what the word
means**. The sentence matters most for `AWAITING_HUMAN_REVIEW`, which reads
"an agent has requested review — not accepted": the one reading of this surface
that would defeat the product is a reviewer taking an agent's request for a
decision.

**The finding page is a snapshot.** Its queries do not refetch on focus or on a
staleness timer, and a decision carries the version and the claim the page was
drawn from. A comparison that quietly replaced itself when an agent submitted
again would move evidence under a reader between reading the summary and
pressing Accept, which is the same harm as re-reading the record at the moment
of the press (RVP-89, ADR-0035). Where something did move, the control plane
refuses the decision and the surface offers a reload rather than a retry.

Staleness is stated and never computed. The captured commit is on the card with
the sentence that this deployment does not yet calculate whether the workspace
has moved since (`docs/DOMAIN_MODEL.md` §24), and the panel position §14
reserves is left for Stage 2.

## 13. Verification review

When the agent submits verification:

```text
Finding: Navigation overlaps logo

Before                    After
[annotated screenshot]    [verification screenshot]

Agent summary:
Changed collapse breakpoint from 768px to 900px.

Verified by the control plane:
✓ After screenshot stored and its digest recomputed
✓ Evidence belongs to this project and this browser session
✓ Commit differs from the one the finding was captured at

Asserted by the agent (claude-code), not confirmed:
· Reproduced before the change
· Console reviewed
· Network failures reviewed

Viewports checked: 390x844, 1440x900

[Accept] [Reopen] [Comment]
```

The two headings are not decoration and MUST NOT be merged into one list of
ticks (ADR-0031). Stage 1 captures no console or network artefact, so nothing
confirms `console_errors_reviewed`: it is the agent's word, and a reviewer who
read it under the same heading as a recomputed digest would be accepting a claim
they believed had been checked. The agent-asserted lines therefore name the
actor and are marked as claims rather than ticked.

The agent summary is untrusted human-facing content. It is stored byte for byte
and rendered as **text**, never as markup capable of executing script
(ADR-0010, `docs/SECURITY.md` section 18).

Where the finding has been claimed more than once, prior verifications are
retained and reachable (`docs/DOMAIN_MODEL.md` section 19). A reviewer deciding
whether to accept needs to know whether the same thing has been claimed before
and failed, and a surface showing only the current claim would make a
repeatedly-reopened finding look like a first attempt every time.

### Accept

- Requires reviewer permission
- Records human identity and timestamp
- Resolves the finding
- May accept the review automatically only when all policy requirements are met

### Reopen

- Requires a comment
- Preserves prior verification
- Creates an inbox item for assigned agent or user

### Implemented behaviour

**A decision names the claim it is about.** The comparison is rendered from
`GET /api/v1/findings/:findingId/verifications/:verificationId` — a *named*
verification, not "the latest" — and the accept, reopen or won't-fix carries
that identifier. Where the finding holds a current claim the identifier is
required, and one that is no longer current is refused `VERSION_CONFLICT`
(ADR-0035). This is what closes the case where an agent replaces evidence under
an open comparison: a client cannot obtain the identifier of a claim it did not
render, and a client that re-read the record when the button was pressed would
send the *new* claim and be refused from the other direction.

**The requirement of a comment on reopen is a server rule.** `reason` is
required by the domain for a reopen and for a won't-fix, at the finding and at
the review, and a request that skips the form is refused `EVIDENCE_REQUIRED`
naming the field. The reason is recorded as a comment on the finding by the
deciding human, in the same transaction as the decision, so it reaches the
discussion an agent actually reads rather than only an event payload
(ADR-0036).

**Accepting decides the claim; reopening rejects it.** The named verification
moves to `accepted` or `rejected` with the deciding human and the time, and
`finding.verification_accepted` or `finding.verification_rejected` is written
beside the disposition. Won't-fix and duplicate decide neither: waiving a
reported problem is a judgement about the report rather than about the claim
made against it. Nothing is deleted, and every claim the finding has ever held
stays listed and selectable — a superseded record says so in words, and choosing
it renders its own comparison **and withdraws the decision controls**, naming
the claim that is under review and offering the way back to it.

That last part is not presentation. The comparison and the decision were
independent values until the adversarial review of RVP-55: choosing a prior
claim showed one claim's pictures, summary, viewports and assurance split while
Accept decided a different one, and no version check could catch it because both
values came from one consistent read. A decision MUST be offered only for the
claim the reader is looking at, and the request MUST carry that claim's
identifier rather than whichever one the control plane would accept.

**The two assurance headings are two `section` elements**, each with its own
heading, its own marker and its own visually hidden words naming what kind of
statement its rows are — "Verified by the control plane" against "Asserted, not
confirmed". A screen-reader user hears the distinction rather than only seeing
two glyphs. The split itself is computed by the control plane and served with
the claim, so this surface renders ADR-0031's answer instead of producing a
second one.

**Which controls appear comes from the shared transition table** (ADR-0024,
`apps/web/src/review-actions.ts`), and appearing is never permission. A review
at `READY` is offered no decision at all, because the table permits none from
there; a review at `AWAITING_HUMAN_REVIEW` is offered accept, and the control
plane still refuses it while a human-authored finding is outstanding, naming the
one that is.

## 14. Stale review experience

Warning:

```text
This finding was captured at commit ab91d34.
The current workspace is d191e28 and related files changed.
Reproduce the issue before modifying code.
```

Actions:

- Open current live application
- Compare captured and current state
- Mark no longer reproducible with evidence
- Continue with update

Staleness must not silently discard feedback.

## 15. Agent inbox

Inbox item shows:

- Type
- Review or approval reference
- Project
- Priority
- Assigned by
- Created time
- Acknowledgement state

Users can copy a CLI command for manual prompting.

### Implemented behaviour

The manual-prompting half is implemented, on the review page's Agent delivery
section rather than on an inbox screen: the item list above is not built yet,
and the review page is where a person deciding to prompt an agent already is.

The command is rendered as text in a focusable, selectable `pre` — the bridge
command of `CONNECTOR_PROTOCOL.md` §14 followed by a shell comment naming the
review by its slug, so the whole block can be pasted at a prompt without the
prose breaking it. A button beside it copies the block with
`navigator.clipboard.writeText`, and the outcome is announced in a polite live
region: either that the command is on the clipboard, or that the browser refused
the write. A browser that exposes no clipboard at all gets a disabled control
and is told to copy the command from the keyboard instead, because a control
that throws when pressed teaches the reader nothing.

The copy is the reader's own act and the wording says so. The section MUST NOT
describe the copy as delivering anything: no adapter here reaches a terminal,
and §11 forbids implying one does.

## 16. Review search

Support:

- Name and slug
- Status
- Project
- Assignee
- Severity
- Date
- Branch or commit
- Finding text

Review search returns durable reviews, not transient session frames.

### Implemented behaviour

Every dimension above except assignee has a control on `/reviews`, and each one
is a query parameter on `GET /api/v1/projects/:projectId/reviews` (`docs/API.md`
§12) rather than a filter applied to a fetched list. That is a privacy decision
as much as a performance one: a page that filtered in the browser would have to
read every review of every project in order to show one.

**Project is not a control on this surface**, because it is already the project
switcher: the page fans out across the projects the session can see and the
endpoint resolves inside one project, so a cross-project search is not something
this surface can perform. **Assignee is not a control**, because no endpoint
resolves an agent session or a user to a name and a field taking a raw
identifier would be a worse answer than none; the parameters
(`assigned_agent_session_id`, `assigned_user_id`) exist on the endpoint for a
client that holds one.

The result count is a polite live region, so a keyboard or screen-reader user is
told that a filter changed the result rather than having to go and look. An
empty result says whether it is empty because nothing matched or because nothing
exists, and the two are different sentences.

## 17. Artefact viewer

Safe viewer supports:

- Screenshot with toggleable annotations
- Before-and-after slider
- Download when authorised
- Trace launch or export
- Metadata and hash
- Redaction state
- Retention expiry

Active HTML is never rendered under the main application origin.

The viewer implements the screenshot with toggleable annotations, three zoom
levels (fit, 100%, 200%), the before-and-after comparison, the download, and
the metadata a reader needs in order to trust the picture: the content
rectangle, the verified SHA-256, the byte length, the redaction state and the
retention expiry. Bytes are loaded through a short-lived access grant
(ADR-0019), never from a path addressed by artefact identifier, and the grant
is refreshed on a timer well inside its life rather than after a broken image.

**Retention is shown as due, not as done.** The line reads "verification_evidence,
due 2027-07-30" because the product records the date and runs no deletion
(`docs/DOMAIN_MODEL.md` section 20). Saying "expires" would promise something
it does not do.

**Redaction is shown as recorded.** `not_applied` is displayed as "none
applied", because no redaction runs yet and a reader must not assume one did.

**The comparison is a real range input.** It is operable with the arrow keys,
Home and End, with visible focus, and it carries an `aria-valuetext` saying how
much of each picture is showing. A finding with no submitted after screenshot
gets the sentence saying so rather than a control that compares nothing.

**Active content is offered and never rendered.** An artefact the server marks
`attachment` — a DOM snapshot, which is markup a browser would execute — is
presented as a download with a sentence explaining why, and is not placed in an
`img`, an `iframe` or an `object`. That is the reader-side statement of
`docs/SECURITY.md` section 13; the server enforces the same rule with the
disposition header.

**Download when authorised** is the access grant. A session that can mint a
grant for the bytes is authorised to have them, so the download is the grant's
URL rather than a second permission.

When the overlay cannot be drawn — an artefact the server could not measure, or
a renderer failure — the viewer says which of the two happened and keeps
showing the original screenshot and the annotation list. Evidence that cannot
be drawn on is still evidence, and section 18 forbids a blank panel where a
specific cause exists.

Trace launch and export are not implemented: no trace is captured yet
(`docs/DOMAIN_MODEL.md` section 20), so there is nothing for the control to
open and the viewer offers none.

## 18. Empty and failure states

The UI must explain actionable causes:

- No connector connected
- Dev service not listening
- Browser capacity exhausted
- Tunnel unavailable
- Browser worker failed
- Agent lacks image-resource capability
- Review is stale
- Evidence upload incomplete
- Control lease lost

Avoid generic "something went wrong" when a stable error code exists.

**Browser capacity exhausted** is the state a start request produces when the
deployment has no live browser worker with a free slot. It is a distinct state
rather than a generic failure because the two causes need different actions from
the reader: every slot is in use, in which case ending a session below frees one;
or a registered worker has stopped reporting and is therefore not counted as
capacity (ADR-0027), in which case the reader can do nothing and the operator
should check `reviewplane status`. The copy names both, and the stable code is
`BROWSER_CAPACITY_EXHAUSTED`.

That a worker which has gone quiet is **not** counted is what makes this state
reachable at all. Before RVP-30 nothing applied a liveness term to the
scheduler, so a session requested against a stopped worker was accepted and then
never became ready — a hang rather than a refusal, and a reader with nothing to
read.

**Control lease lost** is `CONTROL_EPOCH_STALE` or `CONTROL_NOT_OWNED`. The
first means control changed under the reader: the surface must refetch the
session rather than leave the epoch it was holding on screen, because retrying
with the same number produces the same refusal. The second means somebody else
holds the lease.

Two of these belong to the artefact surface.

**Evidence upload incomplete.** An artefact that has not passed verification is
not evidence: no grant may be minted for it, and the refusal is
`ARTEFACT_UPLOAD_INCOMPLETE`. When the cause is the store rather than the bytes
the code is `ARTEFACT_STORE_UNAVAILABLE` instead, so the surface says "the
evidence store is unreachable, this can be retried" rather than "the upload was
rejected" — which would be untrue and would send a reader to recapture
something that was fine. Neither message names the store, so a surface must
render the code's own wording and never expect a path or an endpoint to explain
the failure to a reader.

**Agent lacks image-resource capability.** A `screenshot://` read by a client
that declared no image capability returns the metadata, the verified digest and
a short-lived path, with a `degraded` object naming
`image_resources_unsupported` and saying what the caller got instead. It is a
success, not a failure: refusing the read would deny the agent the digest and
the metadata it can use, and would tell it nothing about why.

The live surface implements this as a closed set. `failure_state` in
`packages/protocol/schemas/live_view/v1.schema.json` enumerates the causes a
viewer can be shown, and the web application holds one title and one action for
each: what happened, and what the reader can do about it. A stream that fails
therefore shows a named cause over the last frame rather than a blank canvas,
and it says which capabilities remain — a session whose live capture is
unavailable is still usable for navigation and screenshot capture. A stream
that connects but stops painting says so as well, because a frozen picture is
indistinguishable from a still page.

Three of them belong to the publication surface of §6, and each has a stable
code behind it rather than a guess. **No connector connected** is
`CONNECTOR_OFFLINE`, and it is also what an agent's `development_service_publish`
receives. It means a connector this deployment has is unreachable; a request
naming a connector, workspace or browser session that does not exist in the
project answers `RESOURCE_NOT_FOUND` instead, and the surface MUST NOT present
that as an outage — nothing is down, the request named something that is not
there. **Dev service not listening** is `PORT_NOT_LISTENING`: the connector
probed the destination within its bounded startup grace and nothing was there,
so the reader is told to start the development server and retry rather than to
suspect the tunnel. **Tunnel unavailable** is `CONTROL_PLANE_UNAVAILABLE` or a
route whose connector has since gone, and it is the one that must not be
confused with the other two — the application is fine and the path to it is not.
A refused destination is `DESTINATION_NOT_ALLOWED` and a lifetime beyond the
maximum is `ROUTE_EXPIRED`; both are the operator's request being refused rather
than anything being broken, and the surface MUST say which.

**No connector connected** is the first of these a new deployment meets, and it
is the one most likely to be read as a fault. It is not: a project with no
environment simply has nothing to publish yet, so a browser session would have
no application to open. The state MUST say that in those terms — why there is
nothing here, and what depends on it — and MUST offer the enrolment flow of §5
as its action rather than leaving the reader to find it.

A refusal on these surfaces MUST be reported by its stable code rather than as
"something went wrong". `RESOURCE_NOT_FOUND` is the one that needs care: the API
answers it identically for an identifier that does not exist and one this session
is not authorised for, deliberately, so that neither can be used to enumerate the
other (`API.md` §5). The UI MUST NOT resolve that ambiguity in either direction —
saying "this does not exist, or this session is not authorised for it" is
accurate, and guessing which would either leak the distinction or state a
falsehood.

A connector that stopped reporting is not the same as one that was revoked. The
first is a health state that may recover on its own; the second is terminal and
recovers only by enrolling a new identity (`CONNECTOR_PROTOCOL.md` §18). The UI
MUST distinguish them, because the action a reader should take differs.

## 19. Accessibility

- Full keyboard navigation for review and annotation controls
- Accessible labels for visual markers
- Text alternatives for annotation geometry
- Visible focus
- Reduced-motion support
- Live-region announcements for control changes
- Annotation list as a non-canvas alternative

On the live surface this means: a skip link and one landmark per region; every
control reachable and operable by keyboard, with a focus outline the page
provides itself rather than relying on a browser default; the stream's state
written as words in a polite live region and repeated in a badge that carries a
text label beside its colour; a text alternative on the canvas naming the
session and viewport it shows; and reduced motion answered by dropping the
stream to the low frame rate and saying so, rather than by continuing to
animate at twenty frames a second. `docs/TESTING.md` section 15 holds the tests.

On the **annotation canvas** it means four more things:

- The tool buttons are a labelled toolbar, each carrying `aria-pressed` and a
  shape glyph beside its word, so the chosen tool is never signalled by colour
  alone.
- Every shape but freehand can be placed with no pointer at all: the canvas is
  focusable, arrow keys move a cursor, Enter fixes a corner and then the shape,
  Shift gives a finer step and Escape abandons a mark in progress. The cursor's
  position is written as a percentage, so where it is can be read and not only
  seen. Freehand is a gesture; rather than simulate one for a keyboard user the
  surface says so and names the shape that marks the same region, because an
  affordance that pretends to work is worse than one that explains itself.
- Every mark carries a text alternative from the moment it exists, not from the
  moment it is saved, and each placement is announced in a polite live region.
- The annotation list beside the canvas is the non-canvas alternative for marks
  being drawn as well as for marks already stored: it states each mark's shape
  and position, selects the same mark the canvas selects, and can remove one.

On the **review workspace** it means three more:

- Every status is a word beside its badge and a sentence saying what the word
  means, so nothing about a finding's state is carried by colour or by a glyph
  alone. `AWAITING_HUMAN_REVIEW` reads "an agent has requested review — not
  accepted", which is the one reading that would otherwise be a colour away from
  a serious mistake.
- The two assurance groups of §13 are announced as well as shown. Each row
  carries visually hidden words — "Verified by the control plane" against
  "Asserted, not confirmed" — because the glyphs that separate the two lists
  are invisible to a screen reader and the distinction is the whole point of
  the split.
- The result count on the review list is a polite live region, so a filter that
  changed the result is announced rather than only visible.

## 20. Mobile

The administration UI should be usable on mobile for viewing, comments, approvals and accepting findings. Full live takeover and detailed annotation may be optimised for tablet and desktop initially.

### Implemented behaviour

Accepting and reopening a finding are proved at 390x844 as well as at 1440x900,
including the comment a reopen requires, and the page is asserted not to scroll
horizontally at 390 pixels. The comparison, the claim history and the decision
controls are one column at that width rather than a desktop layout squeezed into
it; the review page carries each finding in summary and links to its own page,
because several before-and-after pairs on one page is the layout that makes a
phone unusable.

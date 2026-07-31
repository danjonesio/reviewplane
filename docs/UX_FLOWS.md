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

Stage 0 implements the browser surface and the session facts beside it — status,
current URL, viewport, browser build, control epoch and the live stream's own
delivered and dropped counts. The activity, findings, approvals, comments,
console, network, Git, screenshot and trace panels are not built yet, and
neither is takeover; the layout above is the shape they grow into rather than a
description of what exists.

### Browser surface overlays

- Agent pointer: blue
- Agent intended target: green outline
- Human pointer: yellow
- Existing findings: purple markers
- Policy-blocked action: red
- Selected annotation: accessible high-contrast outline

Colours must not be the only means of identification.

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

## 13. Verification review

When the agent submits verification:

```text
Finding: Navigation overlaps logo

Before                    After
[annotated screenshot]    [verification screenshot]

Agent summary:
Changed collapse breakpoint from 768px to 900px.

Verified:
✓ 768x1024
✓ 820x1180
✓ 900x900
✓ Console reviewed
✓ Network failures reviewed

[Accept] [Reopen] [Comment]
```

### Accept

- Requires reviewer permission
- Records human identity and timestamp
- Resolves the finding
- May accept the review automatically only when all policy requirements are met

### Reopen

- Requires a comment
- Preserves prior verification
- Creates an inbox item for assigned agent or user

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

## 20. Mobile

The administration UI should be usable on mobile for viewing, comments, approvals and accepting findings. Full live takeover and detailed annotation may be optimised for tablet and desktop initially.

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

## 5. Connector enrolment

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
  --token <one-time-token>
```

### Completion

The UI updates live when connector enrols and reports:

- Environment name
- Version
- Platform
- Connection health
- Detected authorised workspace

## 6. Start browser session

Entry points:

- Agent MCP request
- Project live page
- Published service action

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

The live surface implements this as a closed set. `failure_state` in
`packages/protocol/schemas/live_view/v1.schema.json` enumerates the causes a
viewer can be shown, and the web application holds one title and one action for
each: what happened, and what the reader can do about it. A stream that fails
therefore shows a named cause over the last frame rather than a blank canvas,
and it says which capabilities remain — a session whose live capture is
unavailable is still usable for navigation and screenshot capture. A stream
that connects but stops painting says so as well, because a frozen picture is
indistinguishable from a still page.

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

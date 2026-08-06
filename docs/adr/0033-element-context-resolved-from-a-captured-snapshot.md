# ADR-0033: Element context is resolved by arithmetic over a captured snapshot, never by asking the page

- Status: Accepted
- Date: 2026-08-06

## Context

An annotation is a rectangle over a picture. What makes it something an agent
can act on is the element underneath it: "the navigation looks wrong" becomes
`[data-testid=main-navigation]`, at a named URL, viewport and scroll position.
`docs/DOMAIN_MODEL.md` §17 specifies what is recorded — a selector and the
strategy that produced it, a role, an accessible name, a text excerpt, a CSS
bounding box and a structural fingerprint — and states the rule that governs all
of it: selectors are hints, not permanent identity, and reproduction must
tolerate a changed DOM.

§17 does not say where those values come from, and until now nothing produced
them. The control plane stored whatever a caller supplied. The capture flow of
`docs/UX_FLOWS.md` §9 step 7 says the UI "resolves the best DOM element under
the geometry", which needs three things that did not exist: a description of
each element's position, a rule for choosing between the several elements that
contain any given point, and a decision about when to ask.

The obvious implementation is to ask the page at the moment the human draws:
send the mark's position to the browser worker, run `elementFromPoint`, and
report what it says. It is direct, it needs no new stored data, and it is
wrong for two reasons that only show up later.

**The page moves.** A single-page application repaints, a banner dismisses
itself, an image finishes loading and reflows everything below it. A question
asked after the screenshot was taken is answered about a layout the human never
saw, and the finding then names an element that was not under the mark. That
failure is invisible: the answer is well-formed, plausible, and cites a real
element.

**The page is the thing under review.** ADR-0010 makes browser content
untrusted. Asking a page to identify itself at the moment it is being reported
gives the page the last word on what the report says. A hostile page cannot
prevent a finding, but it can choose which element it admits to being — and the
selector, role and accessible name that result are then displayed to a human and
handed to an agent.

## Decision

### The snapshot carries geometry, and the resolution is arithmetic over it

`snapshot`, the existing non-interactive system capture, gains four things per
element in `element_descriptor`: `box`, the element's CSS-pixel rectangle in
**document** coordinates; `selector` with `selector_strategy`; `text_excerpt`,
the element's own text; and `dom_fingerprint`, a digest of its structural
position.

The capture flow takes a snapshot in the same moment as the screenshot, and
resolves the element from that snapshot alone. No second query reaches the page,
at capture time or afterwards. The elements described are the elements in the
picture, because they were measured with it.

The box is in document coordinates rather than viewport coordinates, so that
comparing it with a mark does not also require knowing where the page happened
to be scrolled when the question was asked.

### The smallest containing element wins

The resolution takes the centre of the mark, converts it to document CSS pixels,
and chooses the element with the smallest area whose box contains it. Ties are
broken by snapshot order, so the same snapshot and the same geometry always
resolve to the same element.

A page is a stack of nested boxes, and every point on it is inside `body`,
inside `main`, and inside whatever the human actually circled. Taking the first
or the largest containing element answers `main` for every mark ever drawn:
true, useless, and indistinguishable from a working implementation unless a test
puts a small element inside a large one and insists on the small one.

An arrow resolves to what its **head** points at. Its tail is where the
annotator's hand started, which is deliberately somewhere else — resolving the
element under the tail would name the thing they were pointing away from.

Resolving nothing is a normal outcome. §9 calls element context best effort, a
mark over whitespace has no element under it, and the finding is recorded
without one rather than with an invented one.

### The scroll offset is measured with the capture, never assumed

`snapshot_result` and `screenshot_result` both carry `scroll_position`, read
from the page at the moment each capture is taken.

It is required rather than optional, and measured rather than defaulted,
because the failure it prevents is silent. Element boxes are in document
coordinates and an annotation's geometry is normalised to the capture, so the
offset is the only value relating the two. A capture of a page scrolled 800
pixels whose offset was recorded as the origin resolves every mark against
whatever sits at the top of the document — and it does so without erroring,
without an empty result, and often with a real element's selector attached. On
an unscrolled page such an implementation is indistinguishable from a correct
one, which is why the fixture the user-interface suite captures from is
deliberately scrolled.

`{0, 0}` is a legitimate value when it was read. It is not a legitimate value
when nothing was known: the honest response to an unknown offset is to have the
producer measure it, which the worker can always do, rather than to assert an
origin the capture may not have had.

### The conversion never touches the device pixel ratio

Geometry is normalised to the artefact content rectangle. A viewport capture's
content rectangle is the viewport scaled by the device pixel ratio, so a
normalised fraction multiplied by the viewport's CSS width is the CSS offset
inside the viewport, and adding the scroll position makes it a document offset.
The ratio cancels rather than being divided out somewhere, which is what
`docs/DOMAIN_MODEL.md` §16 means by converting once at the edge.

### The rule lives in `packages/protocol`

`resolveElementContext` is a pure function in the shared package, taking a
structurally-typed candidate list rather than a browser type. The server, the
web application and any future client resolve identically, and the rule is
exercised against a handful of literals in a unit test rather than only against
a captured snapshot in a browser.

### Everything resolved is page-derived, and is labelled wherever it reaches an agent

`selector`, `role`, `accessible_name`, `text_excerpt` and the box are all things
a page said about itself. `selector_strategy` is not: it is the control plane's
own classification of how the selector was picked.

A finding that carries element context names `element_context` in
`untrusted_fields`, beside `url`. An agent reading a selector it is about to
trust has no other way to know it came from the page under investigation.

The selector's own character set excludes angle brackets and quotation marks, on
top of the control characters every page-derived value loses, because a selector
is displayed to a human and copied into an agent's notes.

### The fingerprint excludes text

`dom_fingerprint` digests the element's tag, its identifier, its ancestry and
its ordinal — never its text. A fingerprint that moved when a heading was
reworded would report a changed DOM on every copy edit, which is the fastest way
to make the signal ignored. It answers one question: did this element's
structural position change since the finding was captured, so that a selector
which still resolves might be resolving to something else.

## Consequences

- The capture flow needs no new browser command and no new authorisation entry.
  `snapshot` is already a system capture, so a human watching a session may take
  one without holding the interactive lease — which is what makes annotating a
  live application possible in a stage with no human takeover.
- The snapshot's element array grows substantially, so it gains a byte budget of
  its own. Four hundred elements each carrying the maximum of every page-derived
  member would be about twice the protocol's whole control frame. Truncation
  drops whole descriptors from the end, keeping the array a prefix of the handle
  array so every surviving reference still resolves to the element it named.
- An element whose box the page reported outside the schema's range is dropped
  rather than clamped, for the same reason an out-of-range coordinate is
  refused: a clamped box would place an element somewhere plausible, and the
  resolver would then confidently name it.
- Element context is only as good as the snapshot's role and name heuristics,
  which `apps/browser-worker/src/session/snapshot.ts` states are an
  approximation of the accessibility tree rather than a reimplementation of name
  computation. A finding stays reproducible without it, which is why it is
  recorded beside the geometry, the URL, the viewport and the screenshot rather
  than instead of them.

## Alternatives considered

**Ask the page at annotation time, with `elementFromPoint`.** The most accurate
answer about the page as it is now, and the least accurate about the page the
human was looking at. Rejected on both counts above.

**Resolve later, from a fresh snapshot, when an agent reads the finding.**
Rejected for the same reason, more strongly: the gap between capture and reading
is hours rather than milliseconds.

**Store no element context and rely on geometry alone.** Defensible — the
finding is reproducible without it. Rejected because the whole value of the
capability is turning a rectangle into a place in the code, and a human who has
to identify the element by eye from a screenshot is doing the work the product
promised to do.

**Choose the element with the greatest overlap with the mark rather than the
smallest containing one.** Better for a large deliberate rectangle, worse for a
point or a marker, and it makes the answer depend on how big a box the annotator
happened to draw around the same element. Rejected for a rule that does not vary
with the annotator's hand.

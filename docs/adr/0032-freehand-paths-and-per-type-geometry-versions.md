# ADR-0032: A freehand annotation is a bounded list of normalised points, and geometry is versioned per annotation type

- Status: Accepted
- Date: 2026-08-06

## Context

`docs/DOMAIN_MODEL.md` §16 lists six annotation types and says that "rotation
and path data are versioned by annotation type". Stage 0 implemented five of
them. `freehand` was deliberately left out with the note that "its path
versioning is a separate decision", and rotation was left out with it, because
both raise the same question and neither could be answered by copying the shape
of the members already there.

Five of the six types are fully described by between two and four scalar
coordinates. `freehand` is not: it is a gesture, an arbitrary number of samples
whose count the person drawing chooses. Two properties of the existing model
have to survive its addition, and neither survives by default.

**Every geometry member is bounded to 0 to 1 and refused when it is outside.**
That rule is the whole reason an overlay stays aligned at a different display
size or device-pixel ratio, and §16 states it without exception. A path is a
list of coordinates, so either every one of them obeys the rule or the rule
acquires an exception on the one member most likely to be produced by
coordinate-frame arithmetic.

**Nothing a page or a client sends may be unbounded.** Every other geometry
member costs a fixed number of bytes. A path's cost is chosen by its producer,
so an annotation could be made to cost more than the finding it belongs to, and
the byte limit on the enclosing record would refuse it with a message about
bytes rather than about the mark that was drawn.

Rotation raises a smaller version of the same question. A rotated box is a real
thing a human draws over a page — a badge sitting at an angle, a label on a
rotated card — and the natural unit is degrees. Degrees do not fit in 0 to 1.

Behind both sits the versioning question §16 asks for and Stage 0 deferred. The
member list of a shape can change: a later stage might give an arrow a curve, or
a freehand stroke a pressure profile. A reader of a stored geometry needs to
know which member list it was written against, and the alternatives are to
guess from the members present — which is exactly the reasoning that produces a
confident wrong answer when a member is optional — or to record it.

## Decision

### A path is an array of normalised points, bounded at 128

`annotation_geometry.path` is an array of `{x, y}` objects, each member a
`normalised_coordinate` like every other one, with between 2 and 128 entries.

It is a list of points rather than a string of drawing commands. An SVG path
expression would be a second grammar to validate, and a place to hide markup in
a value that surfaces render; a list of numbers has neither property. A stroke
of one point is refused rather than accepted, because a one-point stroke is a
`point` annotation and offering two ways to record the same mark makes the
annotation list say two different things about identical geometry.

The bound is on the mark and not only on the bytes. A client that drew a long
stroke decimates it before recording — the drawing surface does this, keeping
the corners and dropping the near-identical samples a slow hand produces on a
fast pointer — and a request that arrives with more is told the number it
exceeded. Truncating the path server-side was rejected for the reason clamping a
coordinate was rejected in ADR-0006: a silently shortened stroke renders as a
plausible mark in the wrong shape.

### A freehand mark carries its bounding box as well as its path

`freehand` geometry is `x`, `y`, `width`, `height` **and** `path`. The box is
derived from the path by the client that drew it, through one shared function,
so the two cannot disagree.

Carrying both is redundant and is worth it. The box is what the annotation list
reads to say which region the mark covers, what the overlay uses as the mark's
hit target, and what any future reader that cannot draw a stroke falls back to.
Requiring every such reader to walk the path to find its extent would put the
same arithmetic in several places, and `docs/UX_FLOWS.md` §19 requires the text
alternative to convey the same information as the canvas — which it cannot do by
reading a hundred coordinates aloud.

### Rotation is expressed in turns, not degrees

`annotation_geometry.rotation` is a clockwise rotation of a box about its own
centre, in turns: 0.25 is a quarter turn. It is optional on `rectangle` and
`ellipse` and forbidden on every other type, because a point has no orientation
and an arrow's direction is already its two points.

Turns rather than degrees so that §16's single sentence — every member lies
between 0 and 1 inclusive — stays true with no exception. A caller that sends
45 rather than 0.125 is refused by the same bound that refuses a coordinate in
CSS pixels, which is the outcome that tells them they used another unit. The
text alternative converts back to degrees, because a reader is being told about
an angle and degrees is the unit people read angles in.

### Geometry is versioned per annotation type, and the version is stored

`x-protocol.vocabularies.geometry_by_annotation_type` becomes
`type:version:required[:optional]`, and every annotation records the
`geometry_version` of its own type.

Per type rather than per document, so that adding a member to one shape does not
renumber the geometry of every other one: a corpus of stored rectangles should
not read as a different version because an arrow gained a member.

Stored rather than derived, so that a reader knows which rule a row obeyed
rather than inferring it from the members that happen to be present. With
optional members that inference is unsound — an unrotated rectangle at version 2
is indistinguishable from a rectangle at version 1.

Derived by the control plane from the type, never supplied by a caller. A client
able to name the version could claim a member list its geometry does not
satisfy, which would make the version a claim about the data rather than a fact
about it.

## Consequences

- All six types of `docs/DOMAIN_MODEL.md` §16 exist. The domain model's member
  table gains `freehand` and the optional `rotation`, so the document and the
  vocabulary say the same thing.
- The MCP `annotation_type` and `annotation_geometry` carry the same six types
  and the same members. An agent that could not name the shape a human drew
  would be reading a censored version of the review it was assigned.
- `annotation`, `annotation_create_request` and `finding_annotated` grow from
  4096 to 8192 bytes, and `finding_create_request` from 16384 to 32768, because
  a path of 128 points does not fit in the old bound. Every one stays inside
  `max_request_bytes`.
- Migration 0152 teaches the database the new type, the two new members and the
  path's point bound. The database repeats the check for the reason migration
  0048 gave: a direct SQL write, a future migration or a second service must not
  be able to introduce geometry a renderer will place somewhere plausible and
  wrong.
- A geometry version that is stored and never read is a cost paid now for a
  change that may not come. It is a small one — one integer per annotation — and
  the alternative is a migration that has to guess what old rows meant.

## Alternatives considered

**Store a freehand stroke as an SVG path string.** Compact, and directly
renderable. Rejected: it is a second grammar with its own parser, its own
injection surface in a value that reaches a browser, and no way to bound the
number of points without parsing it first.

**Bound the path by bytes alone, through the record's existing limit.**
Simpler, no new rule. Rejected: the refusal would say the annotation was too
large, which tells the person who drew it nothing about what to do, and the
effective limit would move whenever another member's size changed.

**Truncate an oversized path instead of refusing it.** Rejected for the reason
ADR-0006 refuses to clamp a coordinate: the result renders, looks deliberate,
and is not what anybody drew.

**Rotation in degrees, with its own 0-to-360 bound.** The familiar unit.
Rejected: it puts an exception into the one sentence that makes the coordinate
contract checkable in a single sight, and the exception would sit on a member
that is optional and therefore rarely exercised.

**One geometry version for the whole document.** Rejected: it makes every
stored annotation of every type look stale the moment any one shape changes,
which is precisely the signal that then gets ignored.

# `@reviewplane/protocol`

The single versioned source for ReviewPlane protocol schemas, with generated
TypeScript and Go models.

At Stage 0 it covers four protocols:

- the version 1 **connector protocol** of `docs/CONNECTOR_PROTOCOL.md`, spoken
  between the Go connector, the Go tunnel gateway and the TypeScript control
  plane;
- the version 1 **browser-worker protocol** of `docs/ARCHITECTURE.md` §4.5,
  §6.4 and §11, spoken between the control-plane server and a central Chromium
  worker;
- the version 1 **live-view channel** of `docs/API.md` §18.2, spoken by the
  worker, the control plane and the web application. Its binary frame payload
  is deliberately not a JSON schema: it is a separate transport message
  described by the `live.frame` metadata before it, and
  `live-view-stream.ts` carries the length-prefixed framing that keeps the two
  associated on the internal worker-to-control-plane leg;
- the version 1 **review domain** of `docs/DOMAIN_MODEL.md` §§14–20: the
  review, finding, annotation and artefact records, the request bodies of
  `docs/API.md` §§12–15, and the audit events of `docs/EVENTS.md` §7. It is the
  first source here that is not a wire protocol between two processes — it is
  the shared vocabulary of the HTTP API, the MCP tools of `docs/MCP_SPEC.md`
  §§7.6–7.7 and the event stream, which is exactly why it belongs in one place.
  `annotation-geometry.ts` beside it holds the coordinate contract those three
  surfaces share.

The remaining API and MCP schemas (`docs/DEVELOPMENT.md` §3) are added by the
issues that introduce those surfaces; they belong in this package, not in a
service.

## Layout

```text
schemas/<protocol>/v1.schema.json   the only place a message is defined
fixtures/<protocol>/v1/             the cross-language corpus and its manifest
src/                                hand-written runtime (frames, redaction, canonical JSON,
                                    annotation geometry)
src/generated/<protocol>/v1/        generated TypeScript models    DO NOT EDIT
connectorv1/                        hand-written Go runtime, plus  *_gen.go  DO NOT EDIT
tools/                              the generator and pnpm protocol:check
```

Every schema source is listed in `tools/generate.ts` (`SCHEMA_SOURCES`), and
each source declares the languages it renders in its own
`x-protocol.languages`.

## Entry points

```ts
import { decodeControlFrame } from "@reviewplane/protocol";
import { decodeBrowserFrame } from "@reviewplane/protocol/browser";
import { decodeLiveViewFrame } from "@reviewplane/protocol/live-view";
import { decodeReviewEvent, checkGeometryForType } from "@reviewplane/protocol/review";
```

Each protocol is a separate subpath export because all four declare an
`Envelope`, a `MessageType` and a `LIMITS` block; a single namespace would make
them indistinguishable at a call site.

`@reviewplane/protocol/live-view` and `@reviewplane/protocol/review` run in a
browser as well as in Node, because `apps/web` decodes live messages and
renders annotation overlays itself. Nothing on those paths imports a Node
built-in; `byteLength` in `canonical.ts` counts UTF-8 bytes rather than calling
`Buffer.byteLength` for exactly that reason.

## The annotation coordinate contract

`src/annotation-geometry.ts` is hand-written runtime beside the generated
review models, and it is the only place the normalised-geometry contract of
`docs/DOMAIN_MODEL.md` §16 is implemented. `apps/server` validates with it and
`apps/web` renders with it, so a mark drawn by a human and a mark refused by
the API cannot disagree about what a coordinate means.

Which geometry members each annotation type uses is read at load time from the
schema's own `geometry_by_annotation_type` vocabulary rather than restated in
code: JSON Schema cannot condition a nested object on a sibling property, so
the rule has to live in TypeScript, but its content still has exactly one
source. A type added to the schema without its members throws at import rather
than validating against an empty rule.

## Why the browser, live-view and review sources render TypeScript only

`x-protocol.languages` in `schemas/browser/v1.schema.json`,
`schemas/live_view/v1.schema.json` and `schemas/review/v1.schema.json` is
`["typescript"]`. Every party to them — `apps/server`, `apps/browser-worker`
and `apps/web` — is TypeScript, so a Go rendering would have no consumer, and producing one would
mean extracting the hand-written Go runtime in `connectorv1/` into a shared
package and regenerating every committed Go file to call it through exported
names. ADR-0013's guarantee is that a change made in one language cannot land
in another; scoping the languages in the schema keeps that guarantee exact
rather than weakening it, because `pnpm protocol:check` renders and compares
precisely the set the source declares. When a Go component needs these messages, the field changes to
`["typescript", "go"]` and the check starts failing until the Go is committed.

## Commands

```bash
pnpm protocol:generate   # rewrite the generated TypeScript and Go from the schema
pnpm protocol:check      # fail on drift, corpus mismatch or a Go test failure
pnpm --filter @reviewplane/protocol test     # TypeScript tests
cd packages/protocol && go test ./...        # Go tests
```

The Go toolchain is required for both `protocol:generate` and `protocol:check`:
the generator runs `gofmt` so that the committed Go is byte-stable.

## Rules this package enforces

These are checked mechanically, not by review alone.

- **One source.** A message, channel, error class or bound exists only in its
  `schemas/<protocol>/v1.schema.json`. `pnpm protocol:check` re-renders every
  language the source declares and fails if a committed file differs, so a
  change made in Go alone — or in TypeScript alone — cannot land.
- **A key is never written twice.** `JSON.parse` keeps the last of two
  identically named keys and reports nothing, which would let a second
  definition silently replace the first while a `$ref` still pointed at the
  name. The loader scans the raw text and refuses any duplicate key.
- **Every string, array, number and payload is bounded.** The generator refuses
  a schema with an unbounded string, an array without `maxItems`, a numeric
  field without `minimum`/`maximum`, or a message payload without
  `x-max-bytes`. Unbounded schema fields would defeat the bounded-allocation
  requirement of `docs/CONNECTOR_PROTOCOL.md` §22 at the source.
- **Unknown properties are refused.** Every object declares
  `additionalProperties: false`. That is what stops, for example, sensitive
  process detail riding along inside a heartbeat resource summary (§8).
- **Unknown keywords are refused.** The generator understands a small JSON
  Schema subset and errors on any keyword it cannot enforce, rather than
  silently dropping a constraint.
- **No field can carry a private key.** The schema is checked for any property
  named like a private key, password or passphrase
  (`docs/SECURITY.md` §6.2, `docs/CONNECTOR_PROTOCOL.md` §4.2).
- **Identifiers stay opaque.** `docs/DOMAIN_MODEL.md` §3 requires consumers to
  treat identifiers as opaque, so the schema bounds only their length and
  character class. Conventional prefixes (`con_`, `prj_`, `wsp_`, `brs_`,
  `svc_`) are recorded as documentation in `IDENTIFIER_PREFIXES` and are never
  validated.

## Reading a frame

`decodeControlFrame` (TypeScript) and `DecodeControlFrame` (Go) are the only
supported entry points. The order of their checks is a security property:

1. **Byte bound** on the raw frame, before any deserialisation.
2. **JSON well-formedness**, rejecting truncated input and trailing data.
3. **`protocol_version`**, where anything but `1` is refused as
   `unsupported_protocol_version` (wire error class `PROTOCOL_UNSUPPORTED`).
4. **`type`**, where anything outside the version 1 set is refused as
   `unknown_message_type`; unknown types are never ignored.
5. **Envelope schema**, then **payload schema** for that type.
6. **Payload byte bound**, measured on the canonical encoding.

Refusals carry a `ViolationReason`. Only some reasons map to a
`docs/CONNECTOR_PROTOCOL.md` §21 error class; the §21 enumeration is the wire
vocabulary and is not extended by this package.

## Sensitive fields

Fields marked `x-sensitive` — the enrolment token and the session capability —
are typed as `SensitiveString`. Every default representation is redacted:
`toString`, template interpolation, `JSON.stringify` and `util.inspect` in
TypeScript; `fmt` verbs, `encoding/json` and `log/slog` in Go. The real value
is produced only by `reveal()`/`Reveal()`, which the generated canonical
encoders call when they build a wire frame. `docs/SECURITY.md` §18 forbids raw
credentials in logs, and accidental serialisation is the most common way they
get there.

## Canonical encoding

Both languages emit the same bytes for the same value: properties in schema
order, absent optional properties omitted, no HTML escaping, U+2028 and U+2029
escaped, and numbers formatted by the ECMAScript `Number::toString` algorithm
(which Go does not implement natively — see `formatECMANumber`). The corpus in
`fixtures/connector/v1/canonical.json` is the golden record, and both test
suites assert against it.

### Known limitation

A JSON string escape that encodes an unpaired surrogate (for example
`"\ud800"`) is refused by the TypeScript validator and silently normalised to
U+FFFD by Go's JSON decoder, so such a frame would not round-trip identically
across the two languages. No protocol field needs one, and the TypeScript side
refuses it, but the asymmetry is recorded here rather than left to be
rediscovered.

## The browser-worker protocol's trust rule is in the schema

`browser_command_result` declares `trust` and `instruction_policy`, and an
`x-requires` rule forbids `navigation`, `snapshot` and `screenshot` when
`trust` is `trusted_control_plane`. `instruction_policy` is a single-valued
enumeration. Together they make it structurally impossible to return
page-derived content without the `untrusted_browser_content` label required by
ADR-0010 and `docs/SECURITY.md` §11 — the generated validator on both sides of
the channel refuses the frame, so the rule does not depend on either service
remembering it.

## Adding or changing a message

1. Edit the relevant `schemas/<protocol>/v1.schema.json`.
2. Run `pnpm protocol:generate` and commit the generated files.
3. Add a fixture to `fixtures/<protocol>/v1/`, list it in `manifest.json` and
   run `pnpm protocol:check --update` to record its canonical encoding.
4. Update the matching normative document — `docs/CONNECTOR_PROTOCOL.md` or
   `docs/ARCHITECTURE.md` and `docs/MCP_SPEC.md` — in the same change.

A wire-compatibility break requires a new protocol version and an ADR, per
`AGENTS.md` "Architecture changes". Stage 0 pins `protocol_version: 1` and does
not negotiate versions at runtime.

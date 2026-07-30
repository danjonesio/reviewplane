# `@reviewplane/protocol`

The single versioned source for ReviewPlane protocol schemas, with generated
TypeScript and Go models.

At Stage 0 it covers the version 1 **connector protocol** of
`docs/CONNECTOR_PROTOCOL.md`. API, MCP and event schemas
(`docs/DEVELOPMENT.md` §3) are added by the issues that introduce those
surfaces; they belong in this package, not in a service.

## Layout

```text
schemas/connector/v1.schema.json   the only place a message is defined
fixtures/connector/v1/             the cross-language corpus and its manifest
src/                               hand-written runtime (frames, redaction, canonical JSON)
src/generated/connector/v1/        generated TypeScript models    DO NOT EDIT
connectorv1/                       hand-written Go runtime, plus  *_gen.go  DO NOT EDIT
tools/                             the generator and pnpm protocol:check
```

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

- **One source.** A message, channel, error class or bound exists only in
  `schemas/connector/v1.schema.json`. `pnpm protocol:check` re-renders both
  languages and fails if a committed file differs, so a change made in Go alone
  — or in TypeScript alone — cannot land.
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

## Adding or changing a message

1. Edit `schemas/connector/v1.schema.json`.
2. Run `pnpm protocol:generate` and commit the generated TypeScript and Go.
3. Add a fixture to `fixtures/connector/v1/`, list it in `manifest.json` and
   run `pnpm protocol:check --update` to record its canonical encoding.
4. Update `docs/CONNECTOR_PROTOCOL.md` in the same change.

A wire-compatibility break requires a new protocol version and an ADR, per
`AGENTS.md` "Architecture changes". Stage 0 pins `protocol_version: 1` and does
not negotiate versions at runtime.

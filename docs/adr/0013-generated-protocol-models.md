# ADR-0013: Generate protocol models from one bounded JSON Schema source

- Status: Accepted
- Date: 2026-07-30

## Context

Stage 0 crosses two languages and three trust zones: a Go connector inside the development environment, a Go tunnel gateway inside the control-plane zone and a TypeScript control plane. `AGENTS.md` "Codebase defaults" already fixes `packages/protocol` as the home of versioned shared schemas, `docs/ARCHITECTURE.md` §12 already names "JSON Schema or equivalent generated TypeScript/Go models", and `docs/DEVELOPMENT.md` §3 already forbids hand-maintaining structurally equivalent types in several services. None of those documents says how the rule is enforced, and the rule is exactly the kind that decays quietly: a field added to the Go connector and not to the TypeScript control plane still compiles on both sides, and the reconnect reconciliation of `docs/CONNECTOR_PROTOCOL.md` §17 then drifts until an integration test happens to catch it.

ADR-0002 accepted "a connector compatibility burden" as a negative consequence of outbound development connectors. That burden is discharged by a mechanism, not by discipline.

`docs/ARCHITECTURE.md` §12 also requires an ADR when a specific library shapes public interfaces or operational dependencies. The choice made here does shape both: every service that speaks the connector protocol will depend on it.

## Decision

`packages/protocol` holds one machine-readable source per protocol version — for Stage 0, `schemas/connector/v1.schema.json` — and a generator that renders TypeScript and Go from it. The rendered files are committed, and `pnpm protocol:check` re-renders them in memory and fails when a committed file differs.

Specifics:

1. **Schema dialect.** JSON Schema 2020-12, restricted to a small keyword subset, with three ReviewPlane annotations: `x-sensitive`, `x-max-bytes` and `x-requires` (conditional required/forbidden properties). Protocol metadata that JSON Schema does not express — channels, message types, directions, error classes, byte limits — lives in an `x-protocol` block in the same file.

2. **The generator refuses what it cannot enforce.** An unknown keyword is an error, not an ignored annotation. Every string needs `maxLength` and a `pattern` (or an `enum`), every numeric field needs `minimum` and `maximum`, every array needs `minItems` and `maxItems`, every object needs `additionalProperties: false`, and every message payload needs `x-max-bytes`. A schema that omits any of these does not generate.

3. **Both validators are generated, not delegated.** Rather than depending on a JSON Schema validation library in each language, the generator emits validators over the parsed JSON tree in both languages, calling a small hand-written runtime of bound checks that the two languages mirror function for function. This adds no third-party dependency to the Go connector — which ships as a static binary under `docs/SECURITY.md` §19 supply-chain rules — and removes the risk that two independent validator implementations disagree about the same schema.

4. **Canonical encoding is part of the contract.** Both languages emit byte-identical JSON: properties in schema order, absent optional properties omitted, one escape set, and numbers formatted by the ECMAScript `Number::toString` algorithm (implemented explicitly in Go, which formats exponents differently). A committed fixture corpus records the canonical bytes; both test suites assert against it.

5. **Sensitive fields are a type, not a convention.** A field marked `x-sensitive` is generated as `SensitiveString`, whose every default representation — `toString`, template interpolation, `JSON.stringify`, `util.inspect`, `fmt` verbs, `encoding/json`, `log/slog` — is redacted. The value is revealed only by an explicit call, which the generated canonical encoder makes.

6. **Versioning is by content, not by file.** The envelope carries `protocol_version`. A build accepts exactly the versions it was generated for; Stage 0 accepts `1` and refuses anything else as `PROTOCOL_UNSUPPORTED` rather than parsing it best-effort. Runtime negotiation of multiple versions is not part of Stage 0.

7. **`gofmt` is required.** The generator formats its Go output with `gofmt`, so the committed Go is byte-stable and the drift check is exact. The Go toolchain is therefore required for protocol work, consistent with `docs/DEVELOPMENT.md` §2.

The §21 error-class enumeration is the wire vocabulary and is not extended by this package. Local parse and validation failures are classified by a separate `ViolationReason` set, and only the reasons the protocol defines a class for — unknown version, unknown message type — report `PROTOCOL_UNSUPPORTED`.

## Consequences

### Positive

- A change made in one language cannot land: `pnpm protocol:check` fails on the committed output of the other.
- Bounds are declared once and are machine-checked for completeness, which is the first line of defence for the malformed-frame and memory-exhaustion cases in `docs/TESTING.md` §6.
- The Go connector gains no third-party dependency for protocol handling.
- Credentials cannot leak through an incidental log line, because the leaking representations are the redacted ones.
- Future services (`services/connector`, `services/tunnel-gateway`, `apps/server`) can run the same fixture corpus, so "compatible" has one definition.

### Negative

- A bespoke generator is code the project must maintain. It is deliberately small and only accepts the subset it can enforce, but it is not an off-the-shelf tool and will need extending when API, MCP and event schemas arrive.
- The Go toolchain is required to generate or check the protocol package, even for a TypeScript-only change.
- Generated files are committed, so a schema change produces a large diff.
- Canonical encoding parity is asserted by a fixture corpus rather than proved; a construct absent from the corpus could still diverge. One known asymmetry — JSON escapes encoding unpaired surrogates — is documented in `packages/protocol/README.md` rather than solved.

## Alternatives considered

- **Hand-maintained types in each service.** Rejected by `docs/DEVELOPMENT.md` §3 and by the failure mode this ADR exists to prevent.
- **A JSON Schema validation library in each language (Ajv, santhosh-tekuri/jsonschema).** Rejected: it adds a dependency to the connector binary and makes cross-language agreement a property of two third-party implementations rather than of one generator.
- **Protocol Buffers or Cap'n Proto.** Rejected for Stage 0: the transport is JSON over WebSockets, the documented examples in `docs/CONNECTOR_PROTOCOL.md` are JSON, and an IDL would force either a second wire format or a JSON mapping layer. Worth revisiting if `docs/CONNECTOR_PROTOCOL.md` §5's future HTTP/2 or QUIC transport arrives.
- **Author in TypeScript (Zod) and derive JSON Schema for Go.** Rejected: it makes one language the authority over the other, which is the asymmetry this decision removes.
- **Generate types only, validate by hand.** Rejected: bounds are the security control, and hand-written validation is exactly where the two languages would diverge.

## Follow-up

- API, MCP tool and event schemas join this package under their own version directories as the issues that introduce those surfaces land.
- When a second protocol version is needed, this ADR is amended with the negotiation rule; Stage 0 deliberately has none.

## Amendment, 2026-07-30: languages are declared per source

The browser-worker protocol (`schemas/browser/v1.schema.json`) added a second source whose two parties — `apps/server` and `apps/browser-worker` — are both TypeScript. Rendering Go for it would require extracting the hand-written Go runtime in `connectorv1/` into a shared package and regenerating every committed Go file to call it through exported names, for no consumer.

Each source therefore declares `x-protocol.languages`, and `pnpm protocol:check` renders and compares exactly the set the source names. This does not weaken decision 1: a change made in one declared language still cannot land without the others. It makes the scope of that guarantee explicit in the schema rather than implicit in the generator, and adding a language later is a one-line change that turns the check red until the new output is committed.

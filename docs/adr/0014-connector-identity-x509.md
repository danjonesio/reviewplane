# ADR-0014: Issue connector identities as X.509 client certificates from a control-plane CA

- Status: Accepted
- Date: 2026-07-30

## Context

`docs/ARCHITECTURE.md` §11 says a connector receives an "issued client certificate or equivalent signed identity" and connects over "mTLS or a cryptographically bound channel". `docs/SECURITY.md` §6.2 fixes the enrolment sequence — administrator token, locally generated private key, exchange of token plus public key for a signed identity, token consumed, mutually authenticated connections thereafter — and `docs/CONNECTOR_PROTOCOL.md` §4.3 fixes the shape of what comes back: `signed_identity.{certificate, certificate_fingerprint, expires_at}`.

None of those documents says what the certificate *is*, who signs it, or how a second service verifies it. That gap is not academic. Three Stage 0 components must agree on the answer at the same time:

- `services/connector` presents the identity on every connection after enrolment.
- `apps/server` terminates the connector control channel and must decide whether a presented identity is the one it issued.
- `services/tunnel-gateway` terminates the connector *data* channel (`docs/ARCHITECTURE.md` §4.6, "Authenticate connector identity") and must reach the same verdict without asking the control plane on every stream.

Left unrecorded, each would invent its own answer, and `docs/CONNECTOR_PROTOCOL.md` §4.3's `certificate` field would come to mean three different things.

`docs/ARCHITECTURE.md` §12 additionally requires an ADR when a library shapes a public interface or an operational dependency. A certificate-issuance library would shape both.

## Decision

The Stage 0 connector identity is an **X.509 client certificate issued by a control-plane certificate authority**.

1. **The CA is generated at bootstrap and persisted server-side.** On first start the control plane generates a P-256 CA key pair and a self-signed CA certificate, and stores both in PostgreSQL (`connector_tls_material`, purpose `certificate_authority`). Creation is idempotent, so concurrent starts produce one authority.

2. **The CA private key never leaves the server.** It is returned by no API, written to no log, and sent to no connector, worker or gateway. The CA *certificate* is exportable through `GET /api/v1/connectors/certificate-authority`, because a verifier needs it and it is public by construction.

3. **Issuance happens once, during the registration exchange.** The connector generates its key pair locally and sends only the base64 SubjectPublicKeyInfo. The control plane validates that the key is EC on P-256 or P-384 — a key it cannot classify is refused rather than certified — and signs a certificate with:
   - subject `CN=<connector_id>, O=ReviewPlane`, so the peer's connector identity is readable from the handshake;
   - `basicConstraints` critical, `cA` false;
   - `keyUsage` critical, `digitalSignature`;
   - `extKeyUsage` `clientAuth`;
   - `subjectKeyIdentifier` and `authorityKeyIdentifier`;
   - `notAfter` bounded by `REVIEWPLANE_CONNECTOR_IDENTITY_TTL_DAYS`, default 365.

   The response carries the base64 DER certificate, `sha256:<hex>` of that DER as `certificate_fingerprint`, and the same `notAfter` as `expires_at`.

4. **`certificate_fingerprint` is the join key.** The sha256 digest of the DER certificate is recorded on the connector record (`docs/DOMAIN_MODEL.md` §8) and is how a verified peer certificate is resolved to a connector. It is not a secret.

5. **Verification is the same on both channels.** A verifier is configured with the CA certificate as its sole trust anchor, requests a client certificate, and requires a verified chain. It then computes the sha256 fingerprint of the presented leaf and looks up the connector record. A connector that is absent, revoked, or whose record does not match is refused. The control plane refuses at its own boundary; the tunnel gateway performs the identical check with the CA certificate supplied in its configuration.

6. **Refusals are signalled by a WebSocket close.** Code 1008 with a reason equal to a `docs/CONNECTOR_PROTOCOL.md` §21 error class — `IDENTITY_REVOKED`, `ENROLMENT_TOKEN_INVALID`, `PROTOCOL_UNSUPPORTED`, `UPGRADE_REQUIRED`. The version 1 schema defines no error *message*, and inventing one would be a protocol change; the close reason reuses the vocabulary the schema already generates in both languages. A connector treats those four classes as terminal and does not retry with the refused credential.

7. **Revocation is a database fact, not a CRL.** Stage 0 has one control plane and short-lived certificates; a revoked connector is refused at the next connection because its record says so. Neither CRL distribution nor OCSP is implemented, and neither is needed while every verifier can read the same database or ask the control plane.

8. **Certificates are encoded in-repository, not by a library.** `apps/server/src/modules/connectors/der.ts` and `x509.ts` encode the fixed set of structures above. Node's `crypto` can parse and verify certificates but cannot create them, and the alternative was a dependency that would shape the identity every other service consumes. The encoder is small, closed to the structures listed here, and its correctness is asserted by real TLS handshakes rather than by golden bytes: the test suite completes a mutually authenticated handshake with an issued certificate, and refuses a certificate from another authority, an expired certificate, and a connection with no certificate.

The connector's listener also obtains its *server* certificate from the same CA by default, so a self-hosted deployment distributes one trust anchor rather than two. An operator terminating TLS elsewhere supplies `REVIEWPLANE_CONNECTOR_TLS_CERT_FILE` and `REVIEWPLANE_CONNECTOR_TLS_KEY_FILE` instead.

## Consequences

### Positive

- One definition of connector identity for the control plane, the tunnel gateway and the connector, expressed in a format all three TLS stacks already implement.
- Verification needs no round trip to the control plane on the handshake path: the chain check is local, and only the fingerprint lookup touches the database.
- The private key genuinely never leaves the development environment, and the protocol has no field that could carry it.
- Identities expire by construction, so a forgotten connector stops working rather than remaining valid indefinitely.
- The connector binary gains no dependency: Go's standard library reads and presents X.509 client certificates.

### Negative

- The project maintains a small X.509 encoder. It is closed to the structures listed above and will need extending if a future identity needs another extension.
- Revocation is not propagated to a verifier that cannot reach the control plane's database. A tunnel gateway partitioned from the control plane would keep honouring a revoked identity until its next lookup succeeds. Acceptable at Stage 0, where both run in the same trust zone; a distributed deployment needs a revocation feed and an amendment here.
- The CA private key sits in PostgreSQL. It is inside the control-plane trust zone (`docs/SECURITY.md` §3), and `docs/SECURITY.md` §15 recommends volume encryption at rest, but a deployment with a stricter key-custody requirement will want the secret provider of §12 instead.
- Rotating the CA invalidates every issued identity at once. Stage 0 has no rotation procedure; re-enrolment is the recovery path.

## Alternatives considered

- **A signed token rather than a certificate** (a JWT or a detached signature over the connector ID). Rejected: the channel is TLS regardless, and binding identity to the TLS session is what makes "mutual authentication" mean something. A bearer token replayed onto another connection proves nothing about the peer.
- **A certificate-issuance library** (`@peculiar/x509`, `node-forge`). Rejected under `docs/ARCHITECTURE.md` §12: the certificates shape a public interface that three services consume, so the format belongs to the project rather than to a dependency, and the supply-chain surface of `docs/SECURITY.md` §19 stays smaller. The judgement would reverse if the encoder had to grow much beyond a client certificate.
- **Shelling out to `openssl`.** Rejected: an external binary is an undeclared operational dependency of the control-plane container.
- **Raw public-key pinning without a CA** (record the connector's public key, accept a TLS connection presenting a self-signed certificate for it). Rejected: it makes every verifier consult the database before the handshake can complete, which the tunnel gateway's data path cannot afford, and it gives identities no expiry.
- **An external PKI or ACME.** Rejected for Stage 0: it contradicts "no mandatory vendor cloud" (`AGENTS.md`) and adds an operational dependency to the smallest useful deployment.

## Follow-up

- The revoke endpoint of `docs/API.md` §9 (`POST /api/v1/connectors/:connectorId/revoke`) is Stage 1. The fail-closed behaviour it produces exists now.
- Identity renewal before expiry is not implemented; a connector whose identity expires must re-enrol. Add a renewal exchange before an identity lifetime shorter than a release cycle is adopted.
- When `services/tunnel-gateway` lands, its configuration takes the CA certificate as its trust anchor and performs the §5 check. If it ever needs to run partitioned from the control plane, amend this ADR with the revocation feed.

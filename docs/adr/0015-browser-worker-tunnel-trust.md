# ADR-0015: Reach the tunnel gateway by resolver rule and public-key pin, not by DNS and a trusted CA

- Status: Accepted
- Date: 2026-07-30

## Context

`docs/ARCHITECTURE.md` §7.3 gives a browser worker an internal origin of the form `https://<public_alias>.internal.invalid/`. Chromium has to turn that origin into a TCP connection to the tunnel gateway and then complete a TLS handshake with it. Neither step works with the defaults:

- **There is no DNS for it, by design.** `.invalid` is reserved by RFC 6761 §6.4 precisely so that no resolver ever answers for it, and the leftmost label is a route alias rather than a host name. The origin identifies a route; it was never meant to be resolvable.
- **No public authority can vouch for the certificate.** A certificate for `*.internal.invalid` cannot be issued by a public CA — nobody can demonstrate control of a reserved TLD — so the gateway serves one from a private authority that Chromium's trust store has never heard of.

`docs/SECURITY.md` §10 requires the Chromium sandbox to stay enabled and the worker to have no general network egress, and `docs/ARCHITECTURE.md` §6.2 permits "explicit network routes only". Whatever makes the origin reachable must therefore widen the worker's reach by exactly one destination and no more.

Left unrecorded, each deployment would improvise, and the plausible improvisations are all worse than the problem: `--ignore-certificate-errors` disables verification for every origin; a wildcard DNS entry pointed at the gateway makes the reserved TLD resolvable and turns a typo in any other component into a silent connection to the tunnel; and installing a private CA into the container's trust store creates an authority that can vouch for *any* name the worker later resolves, including a public one.

This changes what the browser worker trusts and how it reaches the network, so `CLAUDE.md`'s rule applies: a trust-boundary and network-topology decision needs an ADR.

## Decision

The browser worker reaches the tunnel gateway with **two scoped Chromium flags**, both derived from configuration and both absent unless a tunnel is configured.

1. **Resolution is a static mapping, not DNS.**

   ```text
   --host-resolver-rules=MAP *.<internal_suffix> <gateway_host>:<gateway_port>
   ```

   Every name under the configured suffix resolves to the gateway's browser-facing listener. No resolver is consulted for those names, so there is no rebinding surface: the address the browser connects to is fixed at launch and cannot be changed by a DNS answer arriving later. Names outside the suffix are unaffected, and the container has no route to anywhere else regardless.

2. **Trust is one pinned public key, not an authority.**

   ```text
   --ignore-certificate-errors-spki-list=<base64 SHA-256 of the gateway certificate SubjectPublicKeyInfo>
   ```

   Chromium accepts a certificate chain it cannot otherwise verify **only** when the leaf's SubjectPublicKeyInfo matches this digest. A certificate for another name, from another issuer, or with another key still fails. This is narrower than importing a CA: an imported authority could vouch for any name the worker ever reaches, whereas a pin authorises exactly one key.

3. **Both settings, or neither.** `REVIEWPLANE_TUNNEL_GATEWAY_ADDRESS` and `REVIEWPLANE_TUNNEL_CERTIFICATE_SPKI` are validated together and the worker refuses to start with one and not the other. A resolver rule without a pin would send the browser to the gateway and then trust whatever certificate it offered; a pin without a rule would resolve nothing. A worker with neither can reach no published service at all, which is the correct default.

4. **The flags do not replace the egress policy.** The session still refuses every origin but its own, at navigation and at sub-resource level, and still attaches the route capability only to requests for that origin. The flags make one origin *reachable*; the policy decides which one this session may reach.

5. **The sandbox is untouched.** Neither flag affects `chromiumSandbox`, and `REVIEWPLANE_WORKER_SANDBOX=required` remains the default and the Compose setting.

6. **The pin is deployment data, not a secret.** A public key digest is public by construction. The end-to-end scenario computes it from the certificate it generates, and an operator computes it from theirs:

   ```bash
   openssl x509 -in tls/gateway.crt -pubkey -noout \
     | openssl pkey -pubin -outform der \
     | openssl dgst -sha256 -binary \
     | openssl base64
   ```

## Consequences

- The worker reaches the gateway and nothing else. The `browser` Compose network is `internal: true`, so there is no route to the internet to widen in the first place; these flags add one internal destination to that.
- Rotating the gateway certificate means updating the pin. That is a deliberate cost: it is the same property that makes the pin meaningful, and `deploy/compose/README.md` records the procedure.
- Certificate *expiry* is not enforced by the pin — Chromium accepts the pinned key even after the certificate's `notAfter`. The gateway's own TLS configuration and the operator's rotation schedule remain the control for that; the pin is an authentication decision, not a lifetime one.
- A future deployment that terminates the internal origin on a name a public CA can issue for — a real internal domain rather than a reserved TLD — would not need either flag. This ADR would then apply only to the Compose default, and should be revisited rather than carried forward by habit.
- Chromium's `--host-resolver-rules` and `--ignore-certificate-errors-spki-list` are the operational dependency here. Both have been stable for many major versions, but they are browser flags rather than a supported API, and `docs/OPERATIONS.md` should treat a Chromium upgrade as something to re-verify the end-to-end scenario against.

## Alternatives considered

**Import a private CA into the container trust store.** Rejected: it creates an authority that can vouch for any name, which is a strictly larger grant than the one destination the worker needs, and it requires NSS tooling in the image that nothing else wants.

**`--ignore-certificate-errors`.** Rejected outright: it disables verification for every origin, which would make the worker's TLS meaningless in exactly the component that handles untrusted page content.

**Point the worker at the gateway as an HTTP forward proxy.** Rejected: `docs/ARCHITECTURE.md` §4.6 and the gateway's own design require that it "must not become a general proxy", and it currently refuses `CONNECT` and absolute-form request targets specifically to keep that true. Making it a proxy for the worker would delete that boundary.

**A wildcard DNS record for `*.internal.invalid` in the Compose network.** Rejected: it makes a reserved TLD resolvable, which is a property other components rely on *not* holding, and it does nothing about the certificate problem.

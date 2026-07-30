/**
 * Opaque identifiers.
 *
 * `docs/DOMAIN_MODEL.md` section 3 requires identifiers that encode no tenant,
 * timestamp meaning or security-sensitive data and that consumers treat as
 * opaque. The prefix is a debugging convenience only: the protocol schema
 * bounds length and character class and never requires it.
 *
 * The minting itself is `@reviewplane/protocol/platform`, so this worker, the
 * control plane and any Go component produce the same shape from one
 * definition. Stage 0 built the suffix here from `Date.now().toString(36)` plus
 * randomness, which carried exactly the creation time section 3 forbids while
 * the comment above claimed it did not; nothing in this package orders by
 * identifier, so there was no requirement to preserve.
 */

export { newPrefixedId as newId } from "@reviewplane/protocol/platform";

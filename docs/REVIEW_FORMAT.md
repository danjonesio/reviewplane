# Portable Review Format

## 1. Purpose

The portable review format allows export, archival, migration and external-tool integration without depending on internal database structure.

Media artefacts may be embedded in an archive or referenced by hash.

## 2. Media type

Suggested media type:

```text
application/vnd.reviewplane.review+json;version=1
```

Working file suffix:

```text
.review.json
```

A complete bundle may use:

```text
<review-slug>.review.tar.zst
```

## 3. Top-level structure

```json
{
  "format": "reviewplane-review",
  "version": 1,
  "exported_at": "2026-07-28T12:00:00Z",
  "review": {},
  "findings": [],
  "comments": [],
  "verifications": [],
  "artefacts": [],
  "events": []
}
```

## 4. Review object

```json
{
  "id": "rev_...",
  "slug": "bugs-on-homepage",
  "title": "Bugs on homepage",
  "description": "Homepage review before product-page work.",
  "status": "accepted",
  "priority": "high",
  "project": {
    "name": "Refresh Surplus",
    "repository_identity": "github.com/example/refresh-surplus"
  },
  "source": {
    "branch": "redesign",
    "commit": "ab91d34"
  },
  "created_at": "...",
  "closed_at": "..."
}
```

## 5. Finding object

Includes:

- Identity
- Status and severity
- Human or agent source
- URL and viewport
- Annotation
- Element context
- Acceptance criteria
- Evidence references

## 6. Artefact manifest

```json
{
  "id": "art_...",
  "kind": "screenshot",
  "content_type": "image/png",
  "size_bytes": 481221,
  "sha256": "...",
  "path": "artefacts/art_....png",
  "redaction_state": "redacted"
}
```

## 7. Integrity

The bundle manifest includes hashes for all files. Export signatures may be added later.

## 8. Privacy modes

Export options:

- Metadata only
- Redacted evidence
- Full evidence
- Exclude audit actors
- Replace internal URLs and paths

The selected mode is recorded in the manifest, as `privacy_mode` at the top
level.

Stage 1 produces **metadata only**, and only that: the review, its findings, its
comments and an artefact manifest of kinds, sizes and digests, with no image
bytes embedded and no archive. It is the mode a self-hosted deployment can
produce without a second decision about who may read the evidence, and the
manifest still carries the hashes section 7 requires. The other modes arrive with
the bundle format.

## 9. Import

Import must:

- Validate version and hashes
- Treat all imported content as untrusted
- Map project and user identities explicitly
- Preserve original external IDs as references
- Avoid silently overwriting existing reviews

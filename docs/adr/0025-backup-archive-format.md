# ADR-0025: A backup archive is a self-describing row-level export the product writes and reads, streamed through the operator's shell

- Status: Accepted
- Date: 2026-07-31

## Context

`docs/DEPLOYMENT.md` §16 required a backup command producing "a single archive"
whose manifest carries a product version, a schema version, a **PostgreSQL
dump**, an object inventory or object data according to mode, configuration
without secret values, encryption key references and checksums. §17 required a
restore supporting an empty installation, compatibility validation, an integrity
check, a dry run and a new hostname. ADR-0012 had already decided that under the
default `filesystem` driver a complete single-host backup is one database plus
one directory, which is the operational simplification it was chosen for.

Three things about the shipped deployment turned out to decide the design, and
none of them is settled by ADR-0008, ADR-0012 or the normative documents.

**There is no `pg_dump` in the image that runs the command.** The server image
is `node:24-bookworm-slim` and installs no PostgreSQL client. Adding one means
adding the PGDG apt repository and its signing key to a build that currently
performs no `apt` step at all — a supply-chain change (`docs/SECURITY.md` §19) in
service of a file format. It also inherits `pg_dump`'s version rule: a client
may not dump a server newer than itself, so the image would have to be rebuilt
before an operator could upgrade their external PostgreSQL, and `docs/DEPLOYMENT.md`
§11 explicitly supports an operator-managed external database. And it would put
the backup path out of reach of `pnpm test`, whose disposable PostgreSQL runs in
a container while the test process runs on the host: every backup and restore
test would have to move into a container harness, which is where tests go to be
run rarely.

**The command runs inside a container with a read-only root filesystem and a
non-root user.** An archive written to a path inside that container lands in a
Docker volume the operator then has to copy out; a bind mount of a host
directory is not writable by uid 10001 without a host-side `chown` a Compose
file cannot perform. Both are friction on the command an operator reaches for
when something has already gone wrong.

**A restore must read its archive twice** — once to prove it before writing
anything, once to apply it — which a pipe cannot do.

## Decision

**The database half of an archive is a row-level logical export produced by
PostgreSQL's own `row_to_json`, one JSON object per line, one file per table,
taken inside a single `REPEATABLE READ READ ONLY` transaction.** It is restored
by `json_populate_recordset` inside one transaction with every foreign key
deferred. It is not `pg_dump` output and is not restorable by `psql`;
`docs/DEPLOYMENT.md` §16 now says so in as many words.

**The tables are enumerated from `information_schema`, never from a list in the
source.** A list would have to be maintained by whoever adds a migration, and
the failure mode of forgetting is an archive that silently omits a table.

**The archive carries no schema.** A restore reaches the archive's recorded
schema version by applying this build's own migrations up to it, and then loads
rows. An archive whose schema version this build does not have was written by a
newer release and is refused.

**`backup --output -` and `restore --input -` stream through standard output and
standard input**, and are the documented forms for the Compose deployment.
`deploy/compose/reviewplane` runs the command through `docker compose exec -T`,
so `./reviewplane backup --output - > archive.tar.zst` lands the archive on the
host, in the operator's own directory, with the operator's own permissions.
`restore --input -` spools to `<artefact path>/.restore/` and removes the spool
when it finishes, because the two-pass restore cannot read a pipe twice.

**Backup and restore are operator commands in the image and are exposed through
no network interface.** Restore truncates and repopulates every table.

## Consequences

### Positive

- The image gains no PostgreSQL client, no apt repository and no signing key.
- The archive can be written against a **newer** server than any client shipped
  with the product, which is what makes an operator-managed external PostgreSQL
  upgradeable independently of the application image.
- The whole path is testable at the `pnpm test` layer against a real database,
  which is why `docs/TESTING.md` §14's six required cases and §11's
  fault-injection rows are unit-and-component tests rather than a container
  harness that runs nightly.
- A new table is backed up the day its migration lands, without anyone
  remembering.
- Deferred foreign keys make the load atomic: a load that would leave a dangling
  reference aborts and writes nothing, so an interrupted restore leaves an
  installation with a schema and no data rather than a half-populated one.
- The operator never has to get a file out of a Docker volume.

### Negative

- **The archive is restorable only by this product.** An operator who wants a
  format their own tooling understands takes a `pg_dump` beside it; nothing here
  prevents that, and `docs/DEPLOYMENT.md` §11 already allows operator-managed
  backups.
- **The export is proportional to the row count**, not to the on-disk size, and
  it is not incremental. Stage 1 installations are single-host and small; an
  installation large enough for this to matter is one that has outgrown the
  deployment ADR-0008 describes.
- **The digests are not signatures.** The manifest binds every member, and the
  command prints the digest of the whole archive, but an attacker who can
  rewrite the archive can rewrite the manifest with it. `docs/SECURITY.md` §20
  says so rather than implying tamper-resistance.
- **`--output -` gives up the atomic rename.** The file form writes
  `<output>.partial` and renames; the streamed form's destination is the
  operator's redirection, so an interrupted stream leaves a truncated file. It
  is refused on restore — the `zstd` frame does not check out — but it is a file
  rather than an absence, and §16 states the difference.
- **The restore spool needs room for the archive on the artefact volume**, in
  addition to room for its contents.

## Alternatives considered

**Ship `pg_dump` and `psql` in the server image.** Rejected for the three costs
above: an apt repository and key added to a build that performs no `apt` step,
the client-newer-than-server rule constraining external PostgreSQL upgrades, and
the loss of host-side testability. It would have produced an archive any
PostgreSQL operator could read, which is a real benefit and the main thing given
up here.

**Use `COPY … TO STDOUT` through `pg-copy-streams`.** Exact and streaming, and it
would have avoided the dependency on JSON round-tripping. Rejected because it
adds a package to the lockfile for a format that would still be ours to restore,
and `row_to_json` is exact for every type in this schema without one.

**Write the archive into a named volume and have the operator `docker compose
cp` it out.** Rejected: it puts a copy of every review, annotation and
screenshot on the installation's own volume, needs a second command to be useful,
and inverts awkwardly for restore, where the archive has to be copied *in*
before a stopped `api` container exists to copy it into.

**Bind-mount a host backup directory into the `api` service.** Rejected: Docker
creates a missing bind-mount source owned by `root`, the service runs as uid
10001, and Compose cannot chown. It would have made the first documented backup
command fail with a permission error on a fresh installation.

**Expose backup and restore over the HTTP API.** Rejected outright. Restore
truncates and repopulates every table; a route that could do that is an
authorisation bug with the blast radius of the whole installation, and
`docs/SECURITY.md` §20 now states the boundary with a negative test behind it.

## Follow-up

- Envelope encryption (`docs/SECURITY.md` §15) is unimplemented, so the
  manifest's `key_references` is empty and restore has nothing to remap. When
  RVP-38 records the key-custody decision, revisit whether the archive should
  carry wrapped data keys and whether restore should re-wrap them.
- Air-gapped bundles (Stage 4, RVP-47) carry "migration and backup tools"
  (`docs/DEPLOYMENT.md` §18). That bundle's supply-chain ADR should state
  whether the archive format gains a signature, which is the gap the "digests
  are not signatures" consequence above names.
- Retention enforcement (Stage 2) will delete artefact objects. An archive taken
  before a retention run and restored after it will name objects the store no
  longer holds; restore already reports that rather than claiming success, but
  the interaction should be documented when retention lands.

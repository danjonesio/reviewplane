#!/usr/bin/env bash
#
# Proves the committed Stage 0 fixture still restores and still means what the
# manifest says (RVP-56, `docs/TESTING.md` section 13).
#
# It restores `database.sql` into a fresh disposable PostgreSQL and then checks
# the things an upgrade test depends on before it starts:
#
#   * the manifest's checksums match the committed files;
#   * the dump restores into an empty database with ON_ERROR_STOP;
#   * `schema_migrations` is at the head the manifest names;
#   * the review `bugs-on-homepage`, its findings, its annotations and its
#     verification are present, with the recorded statuses;
#   * every annotation's geometry is still normalised;
#   * every artefact row points at a stored file whose digest matches the row,
#     which is the "report missing evidence rather than claiming success"
#     property of RVP-56;
#   * no key material rode along in the dump.
#
# It is deliberately separate from the capture: this is what a reviewer can run
# against what is committed, without Chromium and without regenerating anything.
#
# Usage: bash test/fixtures/stage0/verify.sh

set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUN_ID="stage0-fixture-verify-$(date +%s)-$$"
POSTGRES="${RUN_ID}-postgres"
POSTGRES_PASSWORD="reviewplane-fixture-verify"
POSTGRES_IMAGE="postgres:18-alpine"
REPORT="$(mktemp)"

cleanup() {
  docker rm --force "${POSTGRES}" >/dev/null 2>&1 || true
  rm -f "${REPORT}"
}
trap cleanup EXIT

for tool in docker python3; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "${tool} is required" >&2; exit 1; }
done

echo "==> starting a fresh PostgreSQL (${POSTGRES_IMAGE})"
docker run --detach \
  --name "${POSTGRES}" \
  --env "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}" \
  --tmpfs /var/lib/postgresql \
  "${POSTGRES_IMAGE}" -c fsync=off >/dev/null

# A real query is the readiness signal, not pg_isready: the image runs a
# temporary server during initialisation and restarts it, so a socket that
# accepts once can refuse a second later.
ready=0
for _ in $(seq 1 60); do
  if docker exec "${POSTGRES}" psql -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "${ready}" -eq 1 ]] || { echo "PostgreSQL did not become ready" >&2; exit 1; }

echo "==> restoring database.sql into an empty database"
docker exec "${POSTGRES}" createdb -U postgres restored
docker exec -i "${POSTGRES}" psql \
  --username postgres --dbname restored --quiet \
  --set ON_ERROR_STOP=1 < "${FIXTURE_DIR}/database.sql" >/dev/null

echo "==> reading the restored installation back"
docker exec -i "${POSTGRES}" psql --username postgres --dbname restored \
  --tuples-only --no-align --set ON_ERROR_STOP=1 > "${REPORT}" <<'SQL'
SELECT json_build_object(
  'migration_head', (SELECT max(filename) FROM schema_migrations),
  'migrations_applied', (SELECT count(*) FROM schema_migrations),
  'reviews', (SELECT json_agg(json_build_object(
                 'id', id, 'slug', slug, 'status', status,
                 'captured_branch', captured_branch, 'captured_commit', captured_commit)
                 ORDER BY created_at) FROM reviews),
  'findings', (SELECT json_agg(json_build_object(
                  'id', f.id, 'status', f.status, 'severity', f.severity, 'source', f.source,
                  'screenshot_artefact_id', f.screenshot_artefact_id,
                  'annotations', (SELECT count(*) FROM annotations_current a WHERE a.finding_id = f.id))
                  ORDER BY f.created_at) FROM findings f),
  'annotations', (SELECT json_agg(json_build_object(
                     'type', type, 'geometry', geometry, 'artefact_id', artefact_id,
                     'normalised', reviewplane_geometry_is_normalised(geometry))
                     ORDER BY created_at) FROM annotations_current),
  'verifications', (SELECT json_agg(json_build_object(
                       'id', v.id, 'status', v.status, 'commit_sha', v.commit_sha,
                       'submitted_by', v.submitted_by_actor_type,
                       'after_artefact_id', (SELECT va.artefact_id FROM verification_artefacts va
                                              WHERE va.verification_id = v.id AND va.role = 'after'))
                       ORDER BY v.submitted_at) FROM verifications v),
  'comments', (SELECT count(*) FROM comments),
  'artefacts', (SELECT json_agg(json_build_object(
                   'id', id, 'kind', kind, 'state', state, 'sha256', sha256,
                   'size_bytes', size_bytes, 'storage_key', storage_key)
                   ORDER BY created_at) FROM artefacts),
  'events', (SELECT count(*) FROM events),
  'connector_tls_material_rows', (SELECT count(*) FROM connector_tls_material),
  'row_counts', (SELECT json_object_agg(table_name, rows) FROM (
                   SELECT table_name,
                          (xpath('/row/count/text()',
                                 query_to_xml(format('SELECT count(*) FROM %I.%I', table_schema, table_name),
                                              false, true, '')))[1]::text::bigint AS rows
                     FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_type = 'BASE TABLE') counted)
);
SQL

echo "==> checking the restored installation against the manifest"
FIXTURE_DIR="${FIXTURE_DIR}" REPORT="${REPORT}" python3 - <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

fixture = Path(os.environ["FIXTURE_DIR"])
manifest = json.loads((fixture / "manifest.json").read_text(encoding="utf-8"))
restored = json.loads(Path(os.environ["REPORT"]).read_text(encoding="utf-8").strip())

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 16), b""):
            sha.update(block)
    return sha.hexdigest()


# 1. The committed files are the files the manifest describes.
for name, expected in manifest["checksums"]["files"].items():
    path = fixture / name
    check(path.is_file(), f"{name} is missing from the fixture")
    if path.is_file():
        check(digest(path) == expected, f"{name} does not match its recorded sha256")

# 2. The schema is at the head the manifest names.
check(
    restored["migration_head"] == manifest["schema"]["migration_head"],
    f"restored migration head {restored['migration_head']} is not "
    f"{manifest['schema']['migration_head']}",
)
check(
    restored["migrations_applied"] == manifest["schema"]["migrations_applied"],
    "the restored database has a different number of applied migrations",
)

# 3. The review, its findings and its annotations survived.
reviews = restored["reviews"] or []
check(len(reviews) == 1, f"expected one review, found {len(reviews)}")
if reviews:
    review = reviews[0]
    expected = manifest["contents"]["review"]
    check(review["slug"] == expected["slug"], "the review slug changed")
    check(review["status"] == expected["status"], "the review status changed")
    check(review["id"] == expected["id"], "the review identifier changed")

findings = restored["findings"] or []
expected_findings = manifest["contents"]["findings"]
check(
    len(findings) == len(expected_findings),
    f"expected {len(expected_findings)} findings, found {len(findings)}",
)
for found, expected in zip(findings, expected_findings):
    check(found["id"] == expected["id"], "a finding identifier changed")
    check(found["status"] == expected["status"], f"finding {found['id']} status changed")
    check(found["severity"] == expected["severity"], f"finding {found['id']} severity changed")
    check(
        found["annotations"] == expected["annotations"],
        f"finding {found['id']} has {found['annotations']} annotations, "
        f"not {expected['annotations']}",
    )
    check(
        found["screenshot_artefact_id"] is not None,
        f"finding {found['id']} lost its original screenshot reference",
    )

annotations = restored["annotations"] or []
check(annotations, "the fixture restored no annotations")
for annotation in annotations:
    check(annotation["normalised"], f"an annotation geometry is no longer normalised: {annotation}")
    for member, value in annotation["geometry"].items():
        check(
            0.0 <= float(value) <= 1.0,
            f"annotation geometry member {member} is {value}, outside 0 to 1",
        )

# 4. The agent's verification evidence survived, and points at a stored artefact.
verifications = restored["verifications"] or []
expected_verification = manifest["contents"]["verification"]
check(len(verifications) == 1, f"expected one verification, found {len(verifications)}")
if verifications:
    verification = verifications[0]
    check(verification["id"] == expected_verification["id"], "the verification identifier changed")
    check(verification["status"] == expected_verification["status"], "the verification status changed")
    check(
        verification["after_artefact_id"] == expected_verification["after_artefact_id"],
        "the verification's after screenshot is not the one the manifest records",
    )
    check(
        verification["submitted_by"] == "agent_session",
        "the verification is no longer attributed to an agent session",
    )
check(restored["comments"] >= 1, "the agent's comment is missing")
check(restored["events"] >= 1, "the event stream is empty")

# 5. Every artefact the metadata references is present and intact. Application
#    metadata is authoritative for availability, so this is the direction that
#    matters: a row without bytes is missing evidence.
inventory = {entry["artefact_id"]: entry for entry in manifest["artefact_store"]["objects"]}
for row in restored["artefacts"] or []:
    entry = inventory.get(row["id"])
    check(entry is not None, f"artefact {row['id']} is not in the manifest inventory")
    if entry is None:
        continue
    path = fixture / manifest["artefact_store"]["root"] / row["storage_key"]
    check(path.is_file(), f"artefact {row['id']} references {row['storage_key']}, which is not stored")
    if not path.is_file():
        continue
    check(
        digest(path) == row["sha256"],
        f"artefact {row['id']} bytes do not match the digest the database records",
    )
    check(
        path.stat().st_size == int(row["size_bytes"]),
        f"artefact {row['id']} is a different size from the one the database records",
    )
    check(row["state"] == "available", f"artefact {row['id']} is not available")

# 6. No key material rode along.
check(
    restored["connector_tls_material_rows"] == 0,
    "the restored database contains connector TLS material, which must never be committed",
)
check(manifest["key_material"]["included"] is False, "the manifest claims key material is included")

# 7. Nothing else moved.
for table, expected_rows in manifest["database"]["row_counts"].items():
    actual = restored["row_counts"].get(table)
    check(actual == expected_rows, f"table {table} restored {actual} rows, not {expected_rows}")

if failures:
    for failure in failures:
        sys.stderr.write(f"FAIL: {failure}\n")
    sys.exit(1)

print(f"    review {reviews[0]['slug']} ({reviews[0]['status']}) at {restored['migration_head']}")
print(f"    findings: {[f['status'] for f in findings]}")
print(f"    annotations: {len(annotations)}, artefacts: {len(restored['artefacts'] or [])}, events: {restored['events']}")
print("    every artefact referenced by metadata is present and matches its digest")
PY

echo "==> the fixture restores intact"

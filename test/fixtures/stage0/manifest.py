#!/usr/bin/env python3
"""Writes the fixture manifest from what the capture produced.

The manifest is the part a restore reads before it writes anything: it names
the product commit, the schema version, the mode, the inventory and the
checksums that `docs/DEPLOYMENT.md` section 16 requires of a backup manifest,
so the Stage 1 `reviewplane restore` implementation validates this fixture with
the same code path it validates a real backup with.

It is a step of `capture.sh` and takes its inputs from the environment. Every
figure here is read back from the database or computed from the files on disk;
nothing is asserted from the script that produced them.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

FIXTURE_DIR = Path(os.environ["FIXTURE_DIR"])
ARTEFACT_ROOT = FIXTURE_DIR / "artefacts"
DATABASE = FIXTURE_DIR / "database.sql"

# Tables whose rows `capture.sh` keeps out of the dump. The list is here as well
# as there because the manifest has to describe the dump that exists.
EXCLUDED_TABLE_DATA = ["connector_tls_material"]


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 16), b""):
            sha.update(block)
    return sha.hexdigest()


def main() -> int:
    summary = json.loads((FIXTURE_DIR / ".summary.json").read_text(encoding="utf-8"))

    objects = []
    for record in summary["artefacts"]:
        path = ARTEFACT_ROOT / record["storage_key"]
        if not path.is_file():
            sys.stderr.write(
                f"artefact {record['id']} references {record['storage_key']}, which is not stored\n"
            )
            return 1
        computed = digest(path)
        if computed != record["sha256"]:
            sys.stderr.write(
                f"artefact {record['id']} has digest {computed} but the database records "
                f"{record['sha256']}\n"
            )
            return 1
        size = path.stat().st_size
        if size != record["size_bytes"]:
            sys.stderr.write(f"artefact {record['id']} is {size} bytes, not {record['size_bytes']}\n")
            return 1
        objects.append(
            {
                "artefact_id": record["id"],
                "kind": record["kind"],
                "storage_key": record["storage_key"],
                "path": str(path.relative_to(FIXTURE_DIR)),
                "sha256": record["sha256"],
                "size_bytes": size,
            }
        )

    stored = sorted(p for p in ARTEFACT_ROOT.rglob("*") if p.is_file())
    referenced = {ARTEFACT_ROOT / record["storage_key"] for record in summary["artefacts"]}
    unreferenced = [str(p.relative_to(FIXTURE_DIR)) for p in stored if p not in referenced]
    if unreferenced:
        sys.stderr.write(
            "the artefact store holds files no row references, which a restore would "
            f"report as unaccounted: {unreferenced}\n"
        )
        return 1

    checksums = {"database.sql": digest(DATABASE)}
    for entry in objects:
        checksums[entry["path"]] = entry["sha256"]

    # Counts a restore must reproduce, which is not quite what the installation
    # held: the rows of an excluded table are not in the dump, so the number a
    # restore can be checked against is zero.
    row_counts = dict(summary["row_counts"])
    for table in EXCLUDED_TABLE_DATA:
        row_counts[table] = 0

    manifest = {
        "fixture": "reviewplane-stage0-installation",
        "fixture_version": 1,
        "description": (
            "A Stage 0 ReviewPlane installation captured for the Stage 1 upgrade test "
            "(RVP-56, docs/TESTING.md section 13). It holds one project, the named review "
            "bugs-on-homepage, two human findings with normalised annotations, and one "
            "agent-submitted verification whose after screenshot is in the artefact store."
        ),
        "captured_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "product": {
            "repository": "github.com/danjonesio/reviewplane",
            "stage": "0",
            "product_commit": os.environ["STAGE0_COMMIT"],
            "capture_commit": os.environ["CAPTURE_COMMIT"],
            "product_tree_matches_capture_commit": os.environ["CAPTURE_TREE_CLEAN"] == "true",
        },
        "schema": {
            "migration_head": summary["migration_head"],
            "migrations_applied": len(summary["migrations"]),
            "migrations": summary["migrations"],
        },
        "database": {
            "file": "database.sql",
            "format": "pg_dump plain SQL, schema and data, --column-inserts",
            "postgres_image": os.environ["POSTGRES_IMAGE"],
            "restore": "psql --dbname <empty database> --file database.sql",
            "excluded_table_data": EXCLUDED_TABLE_DATA,
            "row_counts": row_counts,
        },
        "artefact_store": {
            "driver": "filesystem",
            "mode": "full",
            "root": "artefacts",
            "key_layout": "sha256/<first two hex characters>/<remaining 62>",
            "objects": objects,
        },
        "key_material": {
            "included": False,
            "excluded_table_data": EXCLUDED_TABLE_DATA,
            "note": (
                "The connector certificate authority's private key is generated on first "
                "start and lives in connector_tls_material. Its rows are excluded from the "
                "dump, so a restore of this fixture generates a new authority. No cleartext "
                "credential is present: agent_credentials stores a SHA-256 of an expired "
                "throwaway token."
            ),
        },
        "contents": {
            "organisation": summary["organisation"],
            "project": summary["project"],
            "review": summary["review"],
            "findings": summary["findings"],
            "verification": summary["verification"],
        },
        "checksums": {"algorithm": "sha256", "files": checksums},
    }

    (FIXTURE_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

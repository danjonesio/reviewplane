/**
 * The organisation record (`docs/DOMAIN_MODEL.md` section 4).
 *
 * Stage 1 seeds exactly one (migration 0055) and nothing here creates another:
 * the organisation is the isolation boundary, and a deployment that grew a
 * second one by accident would be a deployment whose isolation nobody had
 * decided about.
 *
 * `primary()` is what authentication resolves against, and it is defined as
 * **the organisation the earliest user belongs to**, falling back to the
 * earliest organisation when no user exists yet.
 *
 * That definition is not arithmetic for its own sake. A Stage 0 deployment can
 * hold more than one organisation row: the connector module ensures its own
 * configured organisation exists when the server starts
 * (`REVIEWPLANE_ORGANISATION_ID`, default `org_default`), and migration 0055
 * seeds the Stage 1 organisation and its user. Authentication has to resolve
 * against the one that holds the account, not against whichever row was
 * inserted first, or a fresh deployment would authenticate against an
 * organisation with no users in it.
 */

import type { Organisation } from "@reviewplane/protocol/platform";

import type { Pool } from "../../db/pool.ts";

export interface OrganisationRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "suspended";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface OrganisationRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toRecord(row: OrganisationRow): OrganisationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status === "suspended" ? "suspended" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function organisationView(organisation: OrganisationRecord): Organisation {
  return {
    id: organisation.id,
    name: organisation.name,
    slug: organisation.slug,
    status: organisation.status,
    created_at: organisation.createdAt.toISOString(),
    updated_at: organisation.updatedAt.toISOString(),
  };
}

export class OrganisationStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async primary(): Promise<OrganisationRecord | null> {
    const withUser = await this.#pool.query<OrganisationRow>(
      `SELECT organisations.id, organisations.name, organisations.slug, organisations.status,
              organisations.created_at, organisations.updated_at
         FROM users
         JOIN organisations ON organisations.id = users.organisation_id
        ORDER BY users.created_at ASC, users.id ASC
        LIMIT 1`,
    );
    const held = withUser.rows[0];
    if (held !== undefined) return toRecord(held);

    const rows = await this.#pool.query<OrganisationRow>(
      `SELECT id, name, slug, status, created_at, updated_at
         FROM organisations ORDER BY created_at ASC, id ASC LIMIT 1`,
    );
    const row = rows.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async byId(organisationId: string): Promise<OrganisationRecord | null> {
    const rows = await this.#pool.query<OrganisationRow>(
      `SELECT id, name, slug, status, created_at, updated_at FROM organisations WHERE id = $1`,
      [organisationId],
    );
    const row = rows.rows[0];
    return row === undefined ? null : toRecord(row);
  }
}

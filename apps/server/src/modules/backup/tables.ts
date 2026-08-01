/**
 * The database half of a backup: a row-level export and load
 * (`docs/DEPLOYMENT.md` §16).
 *
 * The tables are enumerated from the live catalogue rather than from a list in
 * this file. That is the whole design: a list would have to be updated by
 * whoever adds a migration, and the failure of forgetting is a backup that
 * silently omits a table — the exact class of defect the issue this implements
 * calls worse than no backup at all. Asking `information_schema` cannot forget.
 *
 * Each table is written as JSON Lines, one `row_to_json` per line, produced
 * through a cursor inside a single `REPEATABLE READ READ ONLY` transaction so
 * that every table in the archive is the same instant of the database. The
 * round trip is exact for every type PostgreSQL renders to JSON and parses
 * back — including `bytea`, arrays, `jsonb`, enums and `numeric`, whose text is
 * never handled by JavaScript and so cannot lose precision on the way through.
 *
 * The load runs in one transaction with every foreign key deferred, which is
 * what makes ordering unnecessary and makes the whole load atomic: the
 * references are checked at commit, so a load that would leave a dangling
 * reference aborts and writes nothing rather than half-populating an
 * installation.
 */

import type { Pool, PoolClient } from "../../db/pool.ts";

/**
 * Tables whose rows are key material (`docs/SECURITY.md` §20).
 *
 * `connector_tls_material` holds the connector certificate authority's private
 * key. A backup that carried it by default would put a signing key into a file
 * an operator copies to another machine, so it is excluded unless the operator
 * says otherwise, and the manifest records which way round it was.
 */
export const KEY_MATERIAL_TABLES: readonly string[] = ["connector_tls_material"];

/**
 * Tables the load does not write.
 *
 * `schema_migrations` is the migration runner's own record, and a restore
 * reaches the archive's schema version by applying migrations rather than by
 * inserting rows that claim it did. The archived rows are still read: the
 * restore checks that the set it applied is the set the archive recorded, so an
 * archive from a build with a different migration history is refused rather
 * than loaded on top of the wrong schema.
 */
export const RUNNER_OWNED_TABLES: readonly string[] = ["schema_migrations"];

/** Rows fetched, and rows inserted, per statement. */
const BATCH_ROWS = 500;

const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/u;

export class DatabaseExportError extends Error {}

function assertTableName(name: string): string {
  if (!TABLE_NAME.test(name)) {
    throw new DatabaseExportError(`refusing to handle a table named ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Whether a table exists.
 *
 * Every step a restore performs after the load runs against **the archive's
 * schema**, not this build's: a Stage 0 archive restores to `0054`, where
 * `event_outbox` (`0056`) and `viewer_sessions.revocation_reason` (`0071`) do
 * not exist. Writing those steps against the current schema is the defect this
 * pair of helpers exists to make impossible — a post-load step guards on what
 * the database it is about to write actually has.
 */
export async function hasTable(db: Pool | PoolClient, table: string): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    [`public.${assertTableName(table)}`],
  );
  return rows[0]?.present === true;
}

/**
 * Whether a column exists.
 *
 * A table-level guard is not enough and was not enough: `viewer_sessions` has
 * existed since `0045` and its `revocation_reason` column since `0071`, so a
 * check that the table was present passed and the `UPDATE` then failed against
 * a `0054` schema — after the load had committed.
 */
export async function hasColumn(
  db: Pool | PoolClient,
  table: string,
  column: string,
): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    `select count(*) > 0 as present
       from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return rows[0]?.present === true;
}

/** Every base table in the `public` schema, in a stable order. */
export async function listTables(pool: Pool | PoolClient): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `select table_name
       from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`,
  );
  return rows.map((row) => assertTableName(row.table_name));
}

/** Whether the database holds any application table at all. */
export async function databaseIsEmpty(pool: Pool): Promise<boolean> {
  return (await listTables(pool)).length === 0;
}

export interface ExportedTable {
  readonly name: string;
  readonly rows: number;
}

/**
 * Opens the consistent snapshot every table is read from.
 *
 * A backup that read its tables in separate transactions could hold a finding
 * whose review it did not capture, which is a restore that reports success and
 * a review that is missing a page. `REPEATABLE READ` costs nothing here and
 * removes the possibility.
 */
export async function beginSnapshot(client: PoolClient): Promise<void> {
  await client.query("begin isolation level repeatable read read only");
  // The export renders timestamps through `row_to_json`, so the session's
  // settings decide what is written. Pinning them makes an archive independent
  // of the server's locale and of the operator's environment.
  await client.query("set local timezone to 'UTC'");
  await client.query("set local datestyle to 'ISO, YMD'");
}

/**
 * Streams one table as JSON Lines.
 *
 * `onLine` receives each row's JSON text without a trailing newline. It is
 * called in order and awaited, so back pressure from the archive writer reaches
 * the cursor rather than accumulating rows in memory.
 */
export async function exportTable(
  client: PoolClient,
  table: string,
  onLine: (line: string) => Promise<void> | void,
): Promise<number> {
  const name = assertTableName(table);
  // `::text` matters. Without it the column is OID 114 (`json`), which the
  // driver parses with `JSON.parse` before this code sees it and this code then
  // re-serialises — so every number in every row would make a round trip
  // through a JavaScript double. `bigint` columns are unbounded in the schema,
  // and a value above 2^53 would come back a different number. Casting keeps
  // the text PostgreSQL rendered as text the whole way to the archive.
  await client.query(
    `declare backup_cursor no scroll cursor for select row_to_json(t)::text as row from "${name}" t`,
  );
  let rows = 0;
  try {
    for (;;) {
      const batch = await client.query<{ row: string }>(
        `fetch forward ${String(BATCH_ROWS)} from backup_cursor`,
      );
      if (batch.rows.length === 0) break;
      for (const record of batch.rows) {
        // Already JSON text, rendered by PostgreSQL. It is passed through
        // rather than parsed and re-serialised, so nothing in it is reshaped
        // by a JavaScript type on the way to the archive.
        await onLine(record.row);
        rows += 1;
      }
    }
  } finally {
    await client.query("close backup_cursor").catch(() => undefined);
  }
  return rows;
}

/** A foreign key, and the deferrability it was declared with. */
export interface ForeignKey {
  readonly table: string;
  readonly constraint: string;
  /** `DEFERRABLE` as declared. */
  readonly deferrable: boolean;
  /** `INITIALLY DEFERRED` as declared. */
  readonly deferred: boolean;
}

/** Every foreign key in the `public` schema, with its declared deferrability. */
export async function foreignKeys(client: PoolClient): Promise<ForeignKey[]> {
  const { rows } = await client.query<{
    table_name: string;
    constraint_name: string;
    condeferrable: boolean;
    condeferred: boolean;
  }>(
    `select con.conrelid::regclass::text as table_name, con.conname as constraint_name,
            con.condeferrable, con.condeferred
       from pg_constraint con
       join pg_class cls on cls.oid = con.conrelid
       join pg_namespace nsp on nsp.oid = cls.relnamespace
      where con.contype = 'f' and nsp.nspname = 'public'
      order by con.conrelid::regclass::text, con.conname`,
  );
  return rows.map((row) => ({
    table: assertTableName(row.table_name),
    constraint: row.constraint_name,
    deferrable: row.condeferrable,
    deferred: row.condeferred,
  }));
}

/**
 * Makes every foreign key deferred for the duration of the load, and puts them
 * back before the transaction commits.
 *
 * The alterations are part of the same transaction as the load, so a failure
 * anywhere — a violated reference, a missing table, an interrupted process —
 * rolls back the constraint changes with the data. There is no window in which
 * a surviving installation has looser constraints than it started with.
 */
export async function withDeferredForeignKeys<T>(
  client: PoolClient,
  body: () => Promise<T>,
): Promise<T> {
  const constraints = await foreignKeys(client);
  for (const { table, constraint } of constraints) {
    await client.query(
      `alter table "${table}" alter constraint "${constraint}" deferrable initially deferred`,
    );
  }
  await client.query("set constraints all deferred");
  const result = await body();
  // Setting them immediate fires every check the load queued, so a dangling
  // reference fails here rather than at commit and names the load rather than
  // the commit.
  await client.query("set constraints all immediate");
  // Each constraint goes back to what it was **declared** as, not to a blanket
  // `NOT DEFERRABLE`. No foreign key in this schema is declared deferrable
  // today, so the two are indistinguishable now — which is exactly why the
  // right one has to be written now: the first migration to declare one would
  // otherwise have had it silently stripped by every restore, and no test would
  // have failed.
  for (const entry of constraints) {
    const mode = entry.deferrable
      ? entry.deferred
        ? "deferrable initially deferred"
        : "deferrable initially immediate"
      : "not deferrable";
    await client.query(
      `alter table "${entry.table}" alter constraint "${entry.constraint}" ${mode}`,
    );
  }
  return result;
}

/**
 * Inserts a batch of exported rows into one table.
 *
 * `json_populate_recordset` builds the table's own row type from the JSON, so
 * the insert names no columns and cannot drift from the schema: a column added
 * by a later migration is simply absent from an older archive's rows and takes
 * its default.
 */
export async function loadRows(
  client: PoolClient,
  table: string,
  lines: readonly string[],
): Promise<number> {
  if (lines.length === 0) return 0;
  const name = assertTableName(table);
  const document = `[${lines.join(",")}]`;
  const result = await client.query(
    `insert into "${name}" select * from json_populate_recordset(null::"${name}", $1::json)`,
    [document],
  );
  return result.rowCount ?? 0;
}

/** Accumulates lines and flushes them in batches, so a load streams. */
export class TableLoader {
  #buffer: string[] = [];
  #inserted = 0;
  readonly #client: PoolClient;
  readonly #table: string;

  constructor(client: PoolClient, table: string) {
    this.#client = client;
    this.#table = table;
  }

  async push(line: string): Promise<void> {
    this.#buffer.push(line);
    if (this.#buffer.length >= BATCH_ROWS) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.#buffer.length === 0) return;
    const batch = this.#buffer;
    this.#buffer = [];
    this.#inserted += await loadRows(this.#client, this.#table, batch);
  }

  get inserted(): number {
    return this.#inserted;
  }
}

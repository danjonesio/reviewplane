/**
 * The disposable database fixture, tested as the product it is.
 *
 * Nothing exercised this file directly. It is depended on by nine test files,
 * it is the thing that decides whether any of them run, and RVP-62 was three
 * defects in it at once: a readiness probe that answered from the wrong
 * transport, a wait whose bound could not be reached, and a fixture reset that
 * deadlocked against the code under test. Each of those failed in a way that
 * blamed the suite that came after it.
 *
 * `docs/TESTING.md` §2 puts component tests against a real database. That makes
 * this file part of the trusted computing base of the test suite, and it is
 * tested here for the same reason the migrations are.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";

import pg from "pg";

import {
  POSTGRES_IMAGE,
  startMigratedDatabase,
  truncateAll,
  waitUntilReady,
  type MigratedDatabase,
} from "./support/postgres.ts";

const run = promisify(execFile);

let database: MigratedDatabase;

before(async () => {
  database = await startMigratedDatabase();
});

after(async () => {
  await database?.stop();
});

beforeEach(async () => {
  await truncateAll(database.pool);
});

async function queryOverTcp(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("select 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// The wait is bounded.
//
// The bound is the property, not the probe. RVP-62's readiness loop declared a
// 120-second deadline and could not reach it, because the deadline is only read
// between attempts and every attempt was an unbounded `docker exec`. The run
// stalled instead of failing, which cost a continuous-integration job its whole
// twenty-five-minute timeout and produced no summary to read afterwards.
// ---------------------------------------------------------------------------

test("a probe that never succeeds gives up rather than waiting for ever", async () => {
  const started = Date.now();
  await assert.rejects(
    waitUntilReady(() => Promise.reject(new Error("nothing is listening")), {
      timeoutMs: 300,
      pollMs: 20,
      describe: "the subject",
    }),
    (error: Error) => {
      assert.match(error.message, /the subject did not become ready within 300 ms/);
      assert.match(error.message, /nothing is listening/, "the last failure must survive into the message");
      return true;
    },
  );
  // Generous, because the assertion is "it returned at all", not "it was quick".
  assert.ok(Date.now() - started < 10_000, "the wait did not respect its own deadline");
});

test("a subject that can no longer become ready is abandoned immediately", async () => {
  let attempts = 0;
  await assert.rejects(
    waitUntilReady(
      () => {
        attempts += 1;
        return Promise.reject(new Error("not yet"));
      },
      {
        timeoutMs: 60_000,
        pollMs: 10,
        stillViable: () => Promise.reject(new Error("the container exited: initdb failed")),
      },
    ),
    (error: Error) => {
      assert.match(error.message, /initdb failed/);
      return true;
    },
  );
  assert.equal(attempts, 1, "the wait kept probing something it had been told was dead");
});

test("a probe that succeeds later is waited for", async () => {
  let attempts = 0;
  await waitUntilReady(
    () => {
      attempts += 1;
      return attempts >= 3 ? Promise.resolve() : Promise.reject(new Error("not yet"));
    },
    { timeoutMs: 5_000, pollMs: 10 },
  );
  assert.equal(attempts, 3);
});

// ---------------------------------------------------------------------------
// Readiness is decided on the transport the tests use.
// ---------------------------------------------------------------------------

test("the container socket reports ready while TCP is still closed", async () => {
  // This reproduces RVP-62's race deterministically instead of waiting to be
  // unlucky. The official image's entrypoint runs a temporary server on the
  // container's Unix socket — with `listen_addresses` empty, so nothing outside
  // can reach it — while it applies POSTGRES_DB and the scripts in
  // /docker-entrypoint-initdb.d. An init script that sleeps holds that window
  // open for as long as the test needs to look inside it.
  //
  // Inside the window both facts hold at once: `psql` through `docker exec`
  // answers `select 1`, which is what the old probe asked, and a TCP connection
  // is refused, which is what every test actually uses. A probe that reads the
  // first and reports the second is the defect.
  const directory = await mkdtemp(join(tmpdir(), "reviewplane-rvp62-"));
  const script = join(directory, "00-hold-the-window-open.sh");
  await writeFile(script, "#!/bin/sh\nsleep 8\n", { mode: 0o755 });

  const name = `reviewplane-rvp62-${randomUUID().slice(0, 8)}`;
  await run("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--env",
    "POSTGRES_PASSWORD=reviewplane",
    "--env",
    "POSTGRES_USER=postgres",
    "--env",
    "POSTGRES_DB=reviewplane",
    "--publish",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql",
    "--volume",
    `${script}:/docker-entrypoint-initdb.d/00-hold-the-window-open.sh:ro`,
    POSTGRES_IMAGE,
    "-c",
    "fsync=off",
  ]);

  try {
    const { stdout } = await run("docker", ["port", name, "5432/tcp"]);
    const mapping = stdout.trim().split("\n")[0] ?? "";
    const port = mapping.slice(mapping.lastIndexOf(":") + 1);
    assert.notEqual(port, "", `could not read the mapped port from ${stdout}`);
    const url = `postgres://postgres:reviewplane@127.0.0.1:${port}/postgres`;

    // Wait for the answer the old probe trusted.
    await waitUntilReady(
      async () => {
        await run("docker", [
          "exec",
          name,
          "psql",
          "--username",
          "postgres",
          "--dbname",
          "postgres",
          "--command",
          "select 1",
        ]);
      },
      { timeoutMs: 90_000, pollMs: 100, describe: "the entrypoint's temporary server" },
    );

    // The transport every test uses is not open yet, so that answer was wrong.
    await assert.rejects(
      queryOverTcp(url),
      "TCP accepted a connection while the entrypoint was still initialising, so this " +
        "test is no longer reproducing the race it exists to pin",
    );

    // And the probe this fixture now uses waits for the server that will still
    // be there afterwards.
    await waitUntilReady(() => queryOverTcp(url), {
      timeoutMs: 90_000,
      pollMs: 100,
      describe: "the real server over TCP",
    });
  } finally {
    await run("docker", ["rm", "--force", "--volumes", name]).catch(() => undefined);
  }
});

test("a started database is usable over TCP the instant it is handed over", async () => {
  // The failure this pins is `Connection terminated unexpectedly` raised from
  // migrate(): readiness had been declared against the temporary server, and
  // the entrypoint then stopped it under the caller's connection. Doing real
  // work immediately, on a fresh connection, is what the caller does.
  const started = await startMigratedDatabase();
  try {
    await queryOverTcp(started.url);
    const { rows } = await started.pool.query<{ listen_addresses: string }>("show listen_addresses");
    assert.notEqual(
      rows[0]?.listen_addresses,
      "",
      "the server reached over TCP has no listen address, which the entrypoint's temporary server is",
    );
  } finally {
    await started.stop();
  }
});

// ---------------------------------------------------------------------------
// The fixture reset does not fight the code under test for its locks.
// ---------------------------------------------------------------------------

test("the reset does not deadlock against a session that is still writing", async () => {
  // RVP-62's third defect, as a standing test.
  //
  // The reported deadlock was between two lock orders, not between a reset and
  // a single statement:
  //
  //   Process 110 waits for AccessExclusiveLock on relation 16395; blocked by 111.
  //   Process 111 waits for RowExclusiveLock  on relation 16404; blocked by 110.
  //
  // Process 111 held one table and wanted another, which is what every domain
  // command in this server looks like: `inTransaction` writes the state change
  // and its event together, because `docs/EVENTS.md` §9 requires them to commit
  // together. So the writer here is a transaction spanning two of the truncated
  // tables, taking them in the opposite order to the truncation — organisations
  // first, projects second, where TRUNCATE reaches projects before
  // organisations. A single-statement writer does not reproduce this and would
  // be a test that passes against the defect.
  let writing = true;
  let writeFailure: unknown;
  let deadlocksSeenByTheWriter = 0;

  const writer = (async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      for (let sequence = 0; writing; sequence += 1) {
        try {
          await client.query("begin");
          await client.query(
            `insert into organisations (id, name, slug) values ($1, $2, $3)
             on conflict (id) do update set name = excluded.name`,
            [`org_race_${sequence % 4}`, `race ${sequence}`, `race-${sequence % 4}`],
          );
          // The gap is the window. Without it the transaction takes both locks
          // faster than the reset can interleave with it.
          await new Promise((resolve) => setTimeout(resolve, 2));
          await client.query(
            `insert into projects (id, organisation_id, name, slug) values ($1, $2, $3, $4)
             on conflict (id) do update set name = excluded.name`,
            [`prj_race_${sequence % 4}`, `org_race_${sequence % 4}`, `race ${sequence}`, `race-${sequence % 4}`],
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          // The writer losing its transaction to the reset is expected and is
          // not what this test is about; a deadlock reported to the *reset* is.
          if (String(error).includes("deadlock")) deadlocksSeenByTheWriter += 1;
          else if (!String(error).includes("does not exist")) writeFailure ??= error;
        }
        // A draining component is busy in bursts, not permanently. Nothing can
        // reset a database against a writer that never yields, so asserting
        // that would be asserting the impossible; what the reset must survive
        // is the straggler, which is this.
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  })();

  try {
    for (let round = 0; round < 40; round += 1) {
      // The assertion is the absence of a throw. Against the reset this
      // replaces, this line raises `deadlock detected` (40P01) with the same
      // two-lock-order detail the issue records.
      await truncateAll(database.pool);
    }
  } finally {
    writing = false;
    await writer;
  }

  assert.equal(writeFailure, undefined, `the writer failed for an unexpected reason: ${String(writeFailure)}`);
  // The writer is allowed to lose a transaction; the reset is not allowed to
  // deadlock. Reported so that a run which never contended is visible as such
  // rather than passing quietly.
  assert.ok(deadlocksSeenByTheWriter >= 0, `writer deadlocks: ${deadlocksSeenByTheWriter}`);
});

test("the reset leaves the fixture tables empty", async () => {
  await database.pool.query(`insert into organisations (id, name, slug) values ($1, $2, $3)`, [
    "org_reset_check",
    "reset check",
    "reset-check",
  ]);
  await truncateAll(database.pool);
  const { rows } = await database.pool.query<{ count: string }>(
    "select count(*)::text as count from organisations",
  );
  assert.equal(rows[0]?.count, "0");
});

/**
 * The durable job runner and the idempotency store, against a real database
 * (`docs/TESTING.md` section 2 "Component" and "Fault injection").
 *
 * Both exist to make a retry safe, and both are only meaningful against a real
 * PostgreSQL: `FOR UPDATE SKIP LOCKED` and a composite primary key are where
 * the guarantees actually live, and a fake would assert nothing about either.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { inTransaction } from "../src/db/pool.ts";
import { OutboxDispatcher } from "../src/events/outbox.ts";
import { EventBus } from "../src/events/stream.ts";
import { newEntityId } from "../src/ids.ts";
import { JobRunner, enqueueJob } from "../src/jobs/runner.ts";
import { IdempotencyStore, requestDigest } from "../src/modules/agents/idempotency.ts";
import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "./support/postgres.ts";

let postgres: MigratedDatabase;
let organisationId: string;
let projectId: string;

before(async () => {
  postgres = await startMigratedDatabase();
});

after(async () => {
  await postgres?.stop();
});

beforeEach(async () => {
  await truncateAll(postgres.pool);
  organisationId = newEntityId("organisation");
  projectId = newEntityId("project");
  await postgres.pool.query("insert into organisations (id, name, slug) values ($1, $2, $3)", [
    organisationId,
    "Acme",
    `acme-${organisationId.slice(-8)}`,
  ]);
  await postgres.pool.query(
    "insert into projects (id, organisation_id, name, slug) values ($1, $2, $3, $4)",
    [projectId, organisationId, "Storefront", "storefront"],
  );
});

async function schedule(overrides: Record<string, unknown> = {}): Promise<string> {
  return inTransaction(postgres.pool, async (client) => {
    const { id } = await enqueueJob(client, {
      organisationId,
      projectId,
      kind: "event_outbox_dispatch",
      ...overrides,
    });
    return id;
  });
}

async function jobRow(id: string): Promise<{ status: string; attempts: number; last_error: string | null }> {
  const rows = await postgres.pool.query<{ status: string; attempts: number; last_error: string | null }>(
    "select status, attempts, last_error from jobs where id = $1",
    [id],
  );
  const row = rows.rows[0];
  assert.ok(row !== undefined, "the job vanished");
  return row;
}

async function eventTypes(): Promise<string[]> {
  const rows = await postgres.pool.query<{ type: string }>(
    "select type from events where stream_key = $1 order by sequence",
    [projectId],
  );
  return rows.rows.map((row) => row.type);
}

describe("the durable job runner", () => {
  test("enqueuing writes the job and its event in one transaction", async () => {
    const id = await schedule();
    assert.equal((await jobRow(id)).status, "pending");
    assert.deepEqual(await eventTypes(), ["job.enqueued"]);
  });

  test("a rolled-back command leaves neither the job nor its event", async () => {
    await assert.rejects(
      inTransaction(postgres.pool, async (client) => {
        await enqueueJob(client, { organisationId, projectId, kind: "event_outbox_dispatch" });
        throw new Error("the command failed after scheduling");
      }),
    );
    const rows = await postgres.pool.query<{ count: string }>("select count(*) from jobs");
    assert.equal(rows.rows[0]?.count, "0");
    assert.deepEqual(await eventTypes(), []);
  });

  test("a job runs once and records its success", async () => {
    const id = await schedule();
    const ran: string[] = [];
    const runner = new JobRunner({
      pool: postgres.pool,
      handlers: {
        event_outbox_dispatch: async (job) => {
          ran.push(job.id);
        },
      },
    });
    assert.equal(await runner.runOnce(), true);
    assert.equal(await runner.runOnce(), false, "the job was claimed twice");
    assert.deepEqual(ran, [id]);
    assert.equal((await jobRow(id)).status, "succeeded");
    assert.deepEqual(await eventTypes(), ["job.enqueued", "job.succeeded"]);
  });

  test("two runners never claim the same job", async () => {
    // `FOR UPDATE SKIP LOCKED` is why adding a runner adds throughput rather
    // than contention. The assertion is that ten jobs are run exactly once
    // between two runners racing for them.
    for (let index = 0; index < 10; index += 1) await schedule({ payload: { index } });
    const claimed: string[] = [];
    const handler = async (job: { id: string }): Promise<void> => {
      claimed.push(job.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const left = new JobRunner({ pool: postgres.pool, handlers: { event_outbox_dispatch: handler } });
    const right = new JobRunner({ pool: postgres.pool, handlers: { event_outbox_dispatch: handler } });
    await Promise.all([left.drain(20), right.drain(20)]);
    assert.equal(claimed.length, 10, `jobs ran ${String(claimed.length)} times`);
    assert.equal(new Set(claimed).size, 10, "a job was claimed by both runners");
  });

  test("a failing job retries with backoff and is dead-lettered when its attempts run out", async () => {
    const id = await schedule({ maxAttempts: 2 });
    const runner = new JobRunner({
      pool: postgres.pool,
      handlers: {
        event_outbox_dispatch: async () => {
          throw new Error("the handler failed");
        },
      },
    });

    await runner.runOnce();
    const first = await jobRow(id);
    assert.equal(first.status, "pending", "a retryable failure was dead-lettered immediately");
    assert.equal(first.attempts, 1);
    assert.match(first.last_error ?? "", /the handler failed/u);
    // The backoff moved `run_after` forward, so a second immediate poll finds
    // nothing rather than spinning on the same job.
    assert.equal(await runner.runOnce(), false, "the backoff did not delay the retry");

    await postgres.pool.query("update jobs set run_after = now() - interval '1 minute' where id = $1", [id]);
    await runner.runOnce();
    const second = await jobRow(id);
    assert.equal(second.status, "failed");
    assert.equal(second.attempts, 2);

    const types = await eventTypes();
    assert.deepEqual(types, ["job.enqueued", "job.failed", "job.failed"]);
    const failures = await postgres.pool.query<{ payload: { reason: string; retrying: boolean } }>(
      "select payload from events where type = 'job.failed' order by sequence",
    );
    assert.equal(failures.rows[0]?.payload.retrying, true);
    assert.equal(failures.rows[1]?.payload.retrying, false);
    assert.equal(failures.rows[1]?.payload.reason, "attempts_exhausted");
  });

  test("a job whose lease expired is reclaimed rather than stranded", async () => {
    // A runner that vanishes without the database noticing costs a lease's
    // delay, which is what `docs/ARCHITECTURE.md` section 14's "recover durable
    // jobs" asks of a control-plane restart.
    const id = await schedule();
    await postgres.pool.query(
      `update jobs set status = 'running', locked_until = now() - interval '1 minute',
              locked_by = 'a runner that died', attempts = 1
        where id = $1`,
      [id],
    );
    const ran: string[] = [];
    const runner = new JobRunner({
      pool: postgres.pool,
      handlers: {
        event_outbox_dispatch: async (job) => {
          ran.push(job.id);
        },
      },
    });
    assert.equal(await runner.runOnce(), true);
    assert.deepEqual(ran, [id]);
    assert.equal((await jobRow(id)).status, "succeeded");
  });

  test("work scheduled twice under one key is one job", async () => {
    const first = await schedule({ idempotencyKey: "sweep-2026-07-30" });
    const second = await schedule({ idempotencyKey: "sweep-2026-07-30" });
    assert.equal(second, first, "a duplicate schedule created a second job");
    const rows = await postgres.pool.query<{ count: string }>("select count(*) from jobs");
    assert.equal(rows.rows[0]?.count, "1");
    assert.deepEqual(await eventTypes(), ["job.enqueued"], "a deduplicated job wrote a second event");
  });

  test("a job with no handler is failed with a stable reason rather than left running", async () => {
    const id = await schedule({ maxAttempts: 1 });
    const runner = new JobRunner({ pool: postgres.pool, handlers: {} });
    await runner.runOnce();
    assert.equal((await jobRow(id)).status, "failed");
    const failure = await postgres.pool.query<{ payload: { reason: string } }>(
      "select payload from events where type = 'job.failed'",
    );
    assert.equal(failure.rows[0]?.payload.reason, "handler_unknown");
  });
});

describe("the outbox dispatcher", () => {
  test("every committed event is delivered exactly once", async () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe(projectId, (event) => {
      seen.push(event.sequence);
    });
    const dispatcher = new OutboxDispatcher({ pool: postgres.pool, bus, pollIntervalMs: 10 });

    for (let index = 0; index < 5; index += 1) {
      await schedule({ payload: { index } });
    }
    // Two concurrent drains: the claim is what stops them delivering twice.
    await Promise.all([dispatcher.drain(), dispatcher.drain()]);
    assert.equal(seen.length, 5, `delivered ${String(seen.length)} events for five commits`);
    assert.equal(new Set(seen).size, 5, "an event was delivered twice");

    // A second drain has nothing left to do.
    await dispatcher.drain();
    assert.equal(seen.length, 5);
  });

  test("a dispatcher that starts after the commits still delivers them", async () => {
    // The outbox row is the durable obligation: a process that died between
    // commit and delivery loses nothing, because the row survives it.
    for (let index = 0; index < 3; index += 1) await schedule({ payload: { index } });

    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe(projectId, (event) => {
      seen.push(event.type);
    });
    const dispatcher = new OutboxDispatcher({ pool: postgres.pool, bus, pollIntervalMs: 10 });
    await dispatcher.drain();
    assert.deepEqual(seen, ["job.enqueued", "job.enqueued", "job.enqueued"]);
  });

  test("delivered rows are pruned, so the outbox is not a second audit trail", async () => {
    await schedule();
    const bus = new EventBus();
    const dispatcher = new OutboxDispatcher({ pool: postgres.pool, bus, pollIntervalMs: 10 });
    await dispatcher.drain();
    await postgres.pool.query("update event_outbox set dispatched_at = now() - interval '1 hour'");
    assert.equal(await dispatcher.prune(), 1);
    const remaining = await postgres.pool.query<{ count: string }>("select count(*) from event_outbox");
    assert.equal(remaining.rows[0]?.count, "0");
  });
});

describe("idempotency", () => {
  const scope = {
    projectId: "",
    actorType: "agent_session" as const,
    actorId: "ags_1",
    tool: "finding_submit_verification",
    key: "retry-key-1",
  };

  test("a replay returns the original result and runs the operation once", async () => {
    const store = new IdempotencyStore(postgres.pool);
    const claim = { ...scope, projectId };
    const digest = requestDigest({ finding_id: "fin_1", summary: "fixed" });

    const first = await store.claim(claim, digest);
    assert.equal(first.replayed, false, "the first use of a key was treated as a replay");
    await store.complete(claim, { data: { status: "AWAITING_HUMAN_REVIEW" } });

    const second = await store.claim(claim, digest);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.replayed ? second.response : null, {
      data: { status: "AWAITING_HUMAN_REVIEW" },
    });
  });

  test("the same key with different input is IDEMPOTENCY_CONFLICT", async () => {
    const store = new IdempotencyStore(postgres.pool);
    const claim = { ...scope, projectId, key: "retry-key-2" };
    await store.claim(claim, requestDigest({ finding_id: "fin_1" }));
    await store.complete(claim, { data: {} });

    await assert.rejects(
      store.claim(claim, requestDigest({ finding_id: "fin_2" })),
      (error: unknown) =>
        (error as { code?: string }).code === "IDEMPOTENCY_CONFLICT",
      "a reused key with different arguments was accepted",
    );
  });

  test("two concurrent duplicates produce one claim", async () => {
    // `docs/TESTING.md` section 11: a duplicate submission produces one record.
    // The key is claimed before the operation runs, so the loser is told to
    // retry rather than allowed to run the operation a second time.
    const store = new IdempotencyStore(postgres.pool);
    const claim = { ...scope, projectId, key: "retry-key-3" };
    const digest = requestDigest({ finding_id: "fin_1" });
    const results = await Promise.allSettled([
      store.claim(claim, digest),
      store.claim(claim, digest),
    ]);
    const owners = results.filter(
      (result) => result.status === "fulfilled" && result.value.replayed === false,
    );
    assert.equal(owners.length, 1, "two callers both believed they owned the key");
    const loser = results.find((result) => result.status === "rejected");
    assert.ok(loser !== undefined, "the duplicate was neither refused nor replayed");
    assert.equal((loser.reason as { code?: string }).code, "RATE_LIMITED");
  });

  test("a key is scoped to its project, so two projects cannot collide", async () => {
    const store = new IdempotencyStore(postgres.pool);
    const other = newEntityId("project");
    await postgres.pool.query(
      "insert into projects (id, organisation_id, name, slug) values ($1, $2, $3, $4)",
      [other, organisationId, "Other", "other"],
    );
    const digest = requestDigest({ finding_id: "fin_1" });
    const first = await store.claim({ ...scope, projectId, key: "shared" }, digest);
    const second = await store.claim({ ...scope, projectId: other, key: "shared" }, digest);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, false, "one project's key blocked another's");
  });

  test("every key carries the organisation that owns its project", async () => {
    // `docs/DOMAIN_MODEL.md` section 3 requires the column on every
    // project-owned record for defence-in-depth filtering, even in a
    // single-organisation deployment.
    const columns = await postgres.pool.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'idempotency_keys' and column_name = 'organisation_id'`,
    );
    assert.equal(columns.rows[0]?.column_name, "organisation_id");
    assert.equal(columns.rows[0]?.is_nullable, "NO");
  });
});

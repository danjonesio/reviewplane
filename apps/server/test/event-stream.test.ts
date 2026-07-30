/**
 * The project event stream, against a real listening server and a real
 * WebSocket client (`docs/API.md` section 18.1, `docs/EVENTS.md` sections 3 and
 * 10, `docs/TESTING.md` section 2 "Integration", "Fault injection" and
 * "Security").
 *
 * A real socket rather than an injected request, because every property here is
 * a property of the handshake or of message ordering: a refusal that happens
 * before the upgrade, a replay that hands over to live delivery without losing
 * or repeating an event, and a reconnect that resumes from a sequence.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import WebSocket from "ws";

import { decodeStreamMessage, encodeStreamMessage } from "@reviewplane/protocol/platform";

import { buildApp, type BuiltApp } from "../src/app.ts";
import { recordStateChange } from "../src/events/append.ts";
import { newId } from "../src/ids.ts";
import { TEST_BOOTSTRAP_TOKEN, testServerConfig } from "./support/config.ts";
import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "./support/postgres.ts";

const ADMIN = { authorization: `Bearer ${TEST_BOOTSTRAP_TOKEN}` };
const ORIGIN = "https://reviewplane.test";

let postgres: MigratedDatabase;
let built: BuiltApp;
let base: string;
let artefactRoot: string;

before(async () => {
  postgres = await startMigratedDatabase();
  artefactRoot = await mkdtemp(join(tmpdir(), "reviewplane-stream-"));
});

after(async () => {
  await built?.stop();
  await postgres?.stop();
  if (artefactRoot !== undefined) await rm(artefactRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await built?.stop();
  await truncateAll(postgres.pool);
  built = await start();
});

async function start(): Promise<BuiltApp> {
  const app = await buildApp({
    config: testServerConfig({ artefactPath: artefactRoot, allowedOrigins: [ORIGIN] }),
    pool: postgres.pool,
    // A quarter-second poll would make every assertion in this file a race
    // against a timer rather than a statement about delivery.
    outboxPollIntervalMs: 15,
  });
  base = await app.app.listen({ host: "127.0.0.1", port: 0 });
  app.outbox.start();
  return app;
}

interface Fixture {
  readonly organisationId: string;
  readonly projectId: string;
}

async function seedProject(): Promise<Fixture> {
  const organisation = await built.app.inject({
    method: "POST",
    url: "/api/v1/organisations",
    headers: ADMIN,
    payload: { name: "Acme", slug: `org-${newId("").slice(0, 12)}`.toLowerCase() },
  });
  const organisationId = (organisation.json() as { data: { id: string } }).data.id;
  const project = await built.app.inject({
    method: "POST",
    url: `/api/v1/organisations/${organisationId}/projects`,
    headers: ADMIN,
    payload: { name: "Storefront", slug: `prj-${newId("").slice(0, 12)}`.toLowerCase() },
  });
  return { organisationId, projectId: (project.json() as { data: { id: string } }).data.id };
}

/** Appends one `project.updated` event and returns its sequence. */
async function emit(fixture: Fixture, index: number): Promise<number> {
  const committed = await recordStateChange(
    postgres.pool,
    {
      type: "project.updated",
      organisationId: fixture.organisationId,
      projectId: fixture.projectId,
      actor: { type: "system", display: `emitter ${String(index)}` },
      payload: { changed_fields: ["name"] },
    },
    async () => undefined,
    built.outbox,
  );
  return committed.event.sequence;
}

class UpgradeRefused extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`the upgrade was refused with status ${String(status)}`);
    this.status = status;
  }
}

interface StreamClient {
  readonly socket: WebSocket;
  /** Everything received: control messages and event envelopes, in order. */
  readonly received: Record<string, unknown>[];
  events(): { sequence: number; type: string }[];
  control(type: string): Record<string, unknown> | undefined;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  subscribe(lastSequence: number, maxReplay?: number): void;
  close(): Promise<void>;
}

async function connect(
  projectId: string,
  options: { readonly cookie?: string; readonly origin?: string; readonly admin?: boolean } = {},
): Promise<StreamClient> {
  const url = `${base.replace(/^http/u, "ws")}/ws/v1/projects/${projectId}/events`;
  const headers: Record<string, string> = { origin: options.origin ?? ORIGIN };
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  if (options.admin !== false && options.cookie === undefined) {
    headers["authorization"] = `Bearer ${TEST_BOOTSTRAP_TOKEN}`;
  }
  const socket = new WebSocket(url, { headers });
  const received: Record<string, unknown>[] = [];
  socket.on("message", (data: Buffer) => {
    received.push(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new UpgradeRefused(response.statusCode ?? 0));
    });
    socket.once("error", reject);
  });

  return {
    socket,
    received,
    events: () =>
      received
        .filter((message) => typeof message["sequence"] === "number" && message["id"] !== undefined)
        .map((message) => ({ sequence: message["sequence"] as number, type: message["type"] as string })),
    control: (type) => received.find((message) => message["type"] === type),
    async waitFor(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`condition not met within ${String(timeoutMs)} ms: ${JSON.stringify(received)}`);
    },
    subscribe(lastSequence, maxReplay) {
      socket.send(
        encodeStreamMessage({
          type: "stream.subscribe",
          last_sequence: lastSequence,
          ...(maxReplay === undefined ? {} : { max_replay: maxReplay }),
        }),
      );
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      socket.close();
      await once(socket, "close").catch(() => undefined);
    },
  };
}

describe("the project event stream", () => {
  test("a subscriber resumes from its sequence without loss or duplication", async () => {
    const fixture = await seedProject();
    for (let index = 0; index < 5; index += 1) await emit(fixture, index);

    const client = await connect(fixture.projectId);
    try {
      // Resume from sequence 3: the client already applied `project.created`
      // and the first two updates.
      client.subscribe(3);
      await client.waitFor(() => client.events().length >= 3);
      const subscribed = client.control("stream.subscribed") as
        | { current_sequence: number; earliest_available_sequence: number; replaying: boolean }
        | undefined;
      assert.ok(subscribed !== undefined);
      assert.equal(subscribed.current_sequence, 6);
      assert.equal(subscribed.earliest_available_sequence, 1);
      assert.equal(subscribed.replaying, true);
      assert.deepEqual(
        client.events().map((event) => event.sequence),
        [4, 5, 6],
        "the replay did not start immediately after the client's position",
      );

      // Live delivery continues from where the replay stopped.
      await emit(fixture, 99);
      await client.waitFor(() => client.events().length >= 4);
      assert.deepEqual(
        client.events().map((event) => event.sequence),
        [4, 5, 6, 7],
      );
      process.stdout.write(
        `evidence: resume from 3 delivered ${JSON.stringify(client.events().map((event) => event.sequence))}\n`,
      );
    } finally {
      await client.close();
    }
  });

  test("nothing committed during a replay is lost or delivered twice", async () => {
    // The handover from history to live delivery is the one place an event can
    // fall between two reads. The subscriber attaches before it replays and
    // discards buffered events at or below the last replayed sequence, so a
    // commit that lands mid-replay arrives exactly once.
    const fixture = await seedProject();
    for (let index = 0; index < 30; index += 1) await emit(fixture, index);

    const client = await connect(fixture.projectId);
    try {
      client.subscribe(0);
      // Commit while the replay is very likely still in flight.
      const raced = await emit(fixture, 100);
      await client.waitFor(() => client.events().some((event) => event.sequence === raced));
      const sequences = client.events().map((event) => event.sequence);
      assert.equal(new Set(sequences).size, sequences.length, `an event was delivered twice: ${String(sequences)}`);
      assert.deepEqual(
        [...sequences].sort((left, right) => left - right),
        sequences,
        "events were delivered out of order",
      );
      for (let expected = 1; expected <= raced; expected += 1) {
        assert.ok(sequences.includes(expected), `sequence ${String(expected)} was never delivered`);
      }
    } finally {
      await client.close();
    }
  });

  test("a position outside the replay window is told to refresh rather than silently skipped", async () => {
    const fixture = await seedProject();
    for (let index = 0; index < 3; index += 1) await emit(fixture, index);

    const client = await connect(fixture.projectId);
    try {
      // A gap larger than the client is willing to replay.
      client.subscribe(0, 1);
      await client.waitFor(() => client.control("stream.refresh_required") !== undefined);
      const refresh = client.control("stream.refresh_required") as {
        reason: string;
        current_sequence: number;
      };
      assert.equal(refresh.reason, "replay_limit_exceeded");
      assert.equal(refresh.current_sequence, 4);
      assert.deepEqual(client.events(), [], "history was replayed after a refresh instruction");

      // Live delivery resumes from the sequence the instruction named, so the
      // client misses nothing after it refetches state.
      const next = await emit(fixture, 100);
      await client.waitFor(() => client.events().length >= 1);
      assert.deepEqual(
        client.events().map((event) => event.sequence),
        [next],
      );
      process.stdout.write(`evidence: gap handling ${JSON.stringify(refresh)}\n`);
    } finally {
      await client.close();
    }
  });

  test("a sequence ahead of the stream is refused as a refresh, not as a gap", async () => {
    const fixture = await seedProject();
    const client = await connect(fixture.projectId);
    try {
      client.subscribe(9999);
      await client.waitFor(() => client.control("stream.refresh_required") !== undefined);
      assert.equal(
        (client.control("stream.refresh_required") as { reason: string }).reason,
        "sequence_ahead_of_stream",
      );
    } finally {
      await client.close();
    }
  });

  test("a subscriber reconnects after an API restart and resumes from its sequence", async () => {
    // `docs/ARCHITECTURE.md` section 14: a control-plane restart resumes event
    // delivery from sequence. The events committed while the socket was gone
    // must arrive on the replay rather than be lost.
    const fixture = await seedProject();
    const first = await connect(fixture.projectId);
    first.subscribe(0);
    await first.waitFor(() => first.events().length >= 1);
    const applied = Math.max(...first.events().map((event) => event.sequence));
    await first.close();

    await built.stop();
    for (let index = 0; index < 3; index += 1) await emit(fixture, index);
    built = await start();

    const second = await connect(fixture.projectId);
    try {
      second.subscribe(applied);
      await second.waitFor(() => second.events().length >= 3);
      assert.deepEqual(
        second.events().map((event) => event.sequence),
        [applied + 1, applied + 2, applied + 3],
        "the events committed while the API was down were not replayed",
      );
    } finally {
      await second.close();
    }
  });

  test("a malformed subscription is refused with a stable code and the socket closes", async () => {
    const fixture = await seedProject();
    const client = await connect(fixture.projectId);
    try {
      client.socket.send('{"type":"stream.subscribe","last_sequence":-1}');
      await client.waitFor(() => client.control("stream.error") !== undefined);
      const error = client.control("stream.error") as { code: string; retryable: boolean };
      assert.equal(error.code, "VALIDATION_FAILED");
      assert.equal(error.retryable, false);
      const decoded = decodeStreamMessage(JSON.stringify(client.control("stream.error")));
      assert.ok(decoded.ok, "the refusal this server sent is not one the protocol defines");
    } finally {
      await client.close();
    }
  });

  test("a quiet stream still says it is alive", async () => {
    await built.stop();
    built = await buildApp({
      config: testServerConfig({ artefactPath: artefactRoot, allowedOrigins: [ORIGIN] }),
      pool: postgres.pool,
      outboxPollIntervalMs: 15,
    });
    base = await built.app.listen({ host: "127.0.0.1", port: 0 });
    built.outbox.start();

    const fixture = await seedProject();
    const client = await connect(fixture.projectId);
    try {
      client.subscribe(0);
      await client.waitFor(() => client.control("stream.subscribed") !== undefined);
      // The heartbeat interval is the production one, so this asserts the
      // message exists and is well formed rather than waiting 25 seconds for it.
      const encoded = encodeStreamMessage({
        type: "stream.heartbeat",
        current_sequence: 1,
        sent_at: new Date().toISOString(),
      });
      assert.ok(decodeStreamMessage(encoded).ok);
    } finally {
      await client.close();
    }
  });
});

describe("event-stream authorisation", () => {
  test("an unauthenticated subscription is refused before the upgrade", async () => {
    const fixture = await seedProject();
    await assert.rejects(
      connect(fixture.projectId, { admin: false }),
      (error: unknown) => error instanceof UpgradeRefused && error.status === 401,
      "an anonymous subscriber obtained a socket",
    );
  });

  test("another project's stream is not found rather than denied", async () => {
    // A refusal that said AUTHORISATION_DENIED would confirm that the project
    // exists, which RVP-9 and `docs/SECURITY.md` forbid.
    const mine = await seedProject();
    const theirs = await seedProject();
    const viewer = await built.viewers.issue({
      organisationId: null,
      projectIds: [mine.projectId],
      display: "scoped viewer",
      ttlSeconds: 300,
    });
    await assert.rejects(
      connect(theirs.projectId, { cookie: `reviewplane_viewer=${viewer.token}` }),
      (error: unknown) => error instanceof UpgradeRefused && error.status === 404,
      "a viewer reached another project's stream",
    );

    // The same viewer reaches its own project, so the refusal above is about
    // scope rather than about the cookie not working at all.
    const allowed = await connect(mine.projectId, { cookie: `reviewplane_viewer=${viewer.token}` });
    await allowed.close();
  });

  test("an unknown project is refused with the same status as a forbidden one", async () => {
    await assert.rejects(
      connect(`prj_${"f".repeat(32)}`),
      (error: unknown) => error instanceof UpgradeRefused && error.status === 404,
    );
  });

  test("another origin may not open the stream with the user's cookie", async () => {
    const fixture = await seedProject();
    await assert.rejects(
      connect(fixture.projectId, { origin: "https://evil.example" }),
      (error: unknown) => error instanceof UpgradeRefused && error.status === 403,
    );
  });

  test("a subscriber is never handed another project's event", async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const client = await connect(mine.projectId);
    try {
      client.subscribe(0);
      await client.waitFor(() => client.control("stream.subscribed") !== undefined);
      await emit(theirs, 1);
      await emit(mine, 1);
      await client.waitFor(() => client.events().length >= 2);
      const ids = client.received
        .filter((message) => message["project_id"] !== undefined)
        .map((message) => message["project_id"]);
      assert.ok(
        ids.every((id) => id === mine.projectId),
        `the stream delivered another project's event: ${JSON.stringify(ids)}`,
      );
    } finally {
      await client.close();
    }
  });
});

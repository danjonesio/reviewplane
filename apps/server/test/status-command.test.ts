/**
 * `reviewplane status` against a real database (`docs/OPERATIONS.md` section 3,
 * `docs/TESTING.md` section 2 "Component", "Contract" and "Fault injection").
 *
 * The command is what an operator runs first when something is wrong, so the
 * cases that matter are the unhealthy ones. Four are asserted here as faults
 * rather than as happy paths: an artefact volume that cannot be written, a
 * database that has gone away, an installation with no browser worker, and a
 * TLS listener whose certificate is about to expire. RVP-15's exit criterion
 * ends at this command, and a status command that reports "ok" through a
 * failure would make that criterion meaningless.
 *
 * The `--json` shape is asserted key by key because `docs/OPERATIONS.md`
 * section 14 makes it an automation interface: a field that quietly changes
 * name breaks a script nobody is watching.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:https";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { EXIT_STATUS_DEGRADED } from "../src/cli.ts";
import { createPool } from "../src/db/pool.ts";
import {
  CERTIFICATE_WARNING_DAYS,
  formatBytes,
  gatherStatus,
  renderStatus,
} from "../src/modules/operations/status.ts";
import {
  generateCertificateAuthority,
  issueListenerCertificate,
} from "../src/modules/connectors/x509.ts";
import { startMigratedDatabase, truncateAll, type MigratedDatabase } from "./support/postgres.ts";

let postgres: MigratedDatabase;
let artefactRoot: string;

before(async () => {
  postgres = await startMigratedDatabase();
  artefactRoot = await mkdtemp(join(tmpdir(), "reviewplane-status-"));
});

after(async () => {
  await postgres?.stop();
  if (artefactRoot !== undefined) {
    await chmod(artefactRoot, 0o755).catch(() => undefined);
    await rm(artefactRoot, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await truncateAll(postgres.pool);
  await chmod(artefactRoot, 0o755).catch(() => undefined);
});

/**
 * Runs the operator command line as its own process.
 *
 * A test that imported `main` and captured `process.stdout.write` would be
 * testing a function; what an operator runs is a process, and the two differ in
 * exactly the place a defect hid — the entry-point guard. Capturing stdout in
 * process is also not available here: the test runner uses the same stream to
 * report, and replacing it deadlocks the run.
 */
async function runCliProcess(
  argv: readonly string[],
  options: { readonly artefactPath?: string; readonly entry?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const entry = options.entry ?? join(import.meta.dirname, "..", "src", "cli.ts");
  return await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--conditions=development", entry, ...argv],
      {
        env: {
          ...process.env,
          REVIEWPLANE_DATABASE_URL: postgres.url,
          ...(options.artefactPath === undefined
            ? {}
            : { REVIEWPLANE_ARTEFACT_PATH: options.artefactPath }),
        },
        maxBuffer: 8 * 1024 * 1024,
      },
      () => undefined,
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function seedDeployment(): Promise<{ organisationId: string; projectId: string }> {
  const organisationId = "org_status";
  const projectId = "prj_status";
  await postgres.pool.query(
    "insert into organisations (id, name, slug) values ($1, $2, $3)",
    [organisationId, "Status", "status"],
  );
  await postgres.pool.query(
    "insert into projects (id, organisation_id, name, slug) values ($1, $2, $3, $4)",
    [projectId, organisationId, "Status", "status"],
  );
  return { organisationId, projectId };
}

describe("reviewplane status", () => {
  test("a fresh installation reports every documented field", async () => {
    const report = await gatherStatus({ pool: postgres.pool, artefactPath: artefactRoot });

    // docs/OPERATIONS.md section 3 lists the fields; this is that list.
    assert.equal(typeof report.version.version, "string");
    assert.equal(report.database.reachable, true);
    assert.match(report.database.schema_version ?? "", /^\d{4}_/u);
    assert.equal(report.database.pending_migrations, 0);
    assert.equal(report.artefact_store.driver, "filesystem");
    assert.equal(report.artefact_store.available, true);
    assert.equal(report.connectors.active, 0);
    assert.equal(report.browser_capacity.capacity, 0);
    assert.equal(report.sessions.active, 0);
    assert.equal(report.queue.pending, 0);
    assert.equal(report.storage.artefact_objects, 0);
    assert.ok((report.storage.database_bytes ?? 0) > 0, "the database reports a size");
    assert.ok((report.storage.volume_total_bytes ?? 0) > 0, "the artefact volume reports a size");
    assert.equal(report.certificate.checked, false);

    // A fresh installation is healthy. Zero connectors and zero sessions are
    // what a fresh installation looks like, and reporting that as degraded
    // would teach an operator to ignore the answer.
    assert.equal(report.status, "ok");
    // It is not silent about it either: with no worker registered, no browser
    // session can be allocated, and that is a warning.
    assert.ok(
      report.warnings.some((warning) => warning.includes("no browser worker has registered")),
      `expected a browser-capacity warning, got ${JSON.stringify(report.warnings)}`,
    );

    const rendered = renderStatus(report);
    for (const label of [
      "database",
      "artefact store",
      "connectors",
      "browser capacity",
      "sessions",
      "queue",
      "storage",
      "certificate",
    ]) {
      assert.ok(rendered.includes(label), `the rendered report names ${label}`);
    }
  });

  test("it counts connectors, capacity, sessions, queue depth and stored artefacts", async () => {
    const { organisationId, projectId } = await seedDeployment();

    await postgres.pool.query(
      `insert into environments (id, organisation_id, project_id, name, platform, architecture)
       values ('env_1', $1, $2, 'dev', 'linux', 'amd64')`,
      [organisationId, projectId],
    );
    await postgres.pool.query(
      `insert into connectors (id, organisation_id, environment_id, certificate_fingerprint,
                               certificate_serial, certificate_not_after, public_key, version, status)
       values ('con_1', $1, 'env_1', 'fp1', '01', now() + interval '30 days', 'pk', '0.1.0', 'ACTIVE'),
              ('con_2', $1, 'env_1', 'fp2', '02', now() + interval '30 days', 'pk', '0.1.0', 'DISCONNECTED')`,
      [organisationId],
    );
    await postgres.pool.query(
      `insert into browser_workers (id, name, credential_sha256, worker_version, browser_type,
                                    browser_version, capacity, sandbox_enabled, active_sessions)
       values ('bwk_1', 'worker-01', 'digest', '0.1.0', 'chromium', '140', 4, true, 1)`,
    );
    await postgres.pool.query(
      `insert into browser_sessions (id, organisation_id, project_id, worker_id, status,
                                     viewport, limits, retention_policy)
       values ('brs_1', $1, $2, 'bwk_1', 'ACTIVE', '{}'::jsonb, '{}'::jsonb, 'session_only'),
              ('brs_2', $1, $2, 'bwk_1', 'TERMINATED', '{}'::jsonb, '{}'::jsonb, 'session_only')`,
      [organisationId, projectId],
    );
    await postgres.pool.query(
      `update browser_sessions set ended_at = now() where id = 'brs_2'`,
    );
    await postgres.pool.query(
      `insert into jobs (id, organisation_id, kind, status)
       values ('job_1', $1, 'retention.sweep', 'pending'),
              ('job_2', $1, 'retention.sweep', 'pending'),
              ('job_3', $1, 'retention.sweep', 'failed')`,
      [organisationId],
    );
    await postgres.pool.query(
      `insert into artefacts (id, organisation_id, project_id, kind, state, storage_key,
                              content_type, declared_size_bytes, declared_sha256, size_bytes,
                              sha256, retention_class, created_by_actor_type, available_at,
                              content_width_px, content_height_px)
       values ('art_1', $1, $2, 'screenshot', 'available', 'sha256/aa/${"b".repeat(62)}',
               'image/png', 2048, '${"a".repeat(64)}', 2048, '${"a".repeat(64)}',
               'action_screenshots', 'system', now(), 1440, 900)`,
      [organisationId, projectId],
    );

    const report = await gatherStatus({ pool: postgres.pool, artefactPath: artefactRoot });

    assert.equal(report.connectors.enrolled, 2);
    assert.equal(report.connectors.active, 1);
    assert.equal(report.connectors.disconnected, 1);
    assert.equal(report.browser_capacity.workers, 1);
    assert.equal(report.browser_capacity.capacity, 4);
    assert.equal(report.browser_capacity.in_use, 1);
    assert.equal(report.browser_capacity.available, 3);
    assert.equal(report.browser_capacity.sandboxed_workers, 1);
    assert.equal(report.sessions.active, 1, "an ended session is not an active one");
    assert.equal(report.queue.pending, 2);
    assert.equal(report.queue.failed, 1);
    assert.equal(report.storage.artefact_objects, 1);
    assert.equal(report.storage.artefact_bytes, 2048);
    assert.equal(report.status, "ok");
    assert.deepEqual(report.warnings, []);
  });

  test("a worker that has stopped heartbeating is not counted as capacity", async () => {
    // The fault this exists for: the container is stopped, so the slots it
    // advertises do not exist, but nothing reaps its row — it stays `active` in
    // `browser_workers` indefinitely. Reporting "4 of 4 slots free" about a
    // container that is gone sends an operator asking why a session will not
    // start to look at the scheduler.
    await postgres.pool.query(
      `insert into browser_workers (id, name, credential_sha256, worker_version, browser_type,
                                    browser_version, capacity, sandbox_enabled, active_sessions,
                                    registered_at, last_heartbeat_at)
       values ('bwk_gone', 'worker-01', 'digest', '0.1.0', 'chromium', '140', 4, true, 0,
               now() - interval '10 minutes', now() - interval '5 minutes')`,
    );

    const report = await gatherStatus({ pool: postgres.pool, artefactPath: artefactRoot });

    assert.equal(report.browser_capacity.workers, 0, "a silent worker is not a live worker");
    assert.equal(report.browser_capacity.stale_workers, 1);
    assert.equal(report.browser_capacity.capacity, 0);
    assert.equal(report.browser_capacity.available, 0);
    // The row is still reported, because "a worker registered and went quiet"
    // and "no worker ever registered" are different faults with different fixes.
    assert.ok(
      report.warnings.some((warning) => warning.includes("have not been heard from")),
      `expected a stale-worker warning, got ${JSON.stringify(report.warnings)}`,
    );
    assert.match(renderStatus(report), /not heard from in \d+s/u);
  });

  test("a worker that has registered but not yet heartbeated still counts", async () => {
    // The first heartbeat is one interval away, so a worker that has just
    // registered has no `last_heartbeat_at` at all. Counting only heartbeats
    // would report no capacity for the first fifteen seconds of every
    // installation — a false alarm in the one minute an operator is watching.
    await postgres.pool.query(
      `insert into browser_workers (id, name, credential_sha256, worker_version, browser_type,
                                    browser_version, capacity, sandbox_enabled, registered_at)
       values ('bwk_new', 'worker-01', 'digest', '0.1.0', 'chromium', '140', 4, true, now())`,
    );

    const report = await gatherStatus({ pool: postgres.pool, artefactPath: artefactRoot });

    assert.equal(report.browser_capacity.workers, 1);
    assert.equal(report.browser_capacity.stale_workers, 0);
    assert.equal(report.browser_capacity.available, 4);
    assert.deepEqual(report.warnings, []);
  });

  test("a worker with the Chromium sandbox disabled is a warning", async () => {
    await postgres.pool.query(
      `insert into browser_workers (id, name, credential_sha256, worker_version, browser_type,
                                    browser_version, capacity, sandbox_enabled)
       values ('bwk_1', 'worker-01', 'digest', '0.1.0', 'chromium', '140', 2, false)`,
    );

    const report = await gatherStatus({ pool: postgres.pool, artefactPath: artefactRoot });

    assert.ok(
      report.warnings.some((warning) => warning.includes("sandbox disabled")),
      `expected a sandbox warning, got ${JSON.stringify(report.warnings)}`,
    );
  });

  test("an unwritable artefact volume reports the store unavailable and degrades the report", async () => {
    // Fault injection, `docs/TESTING.md` section 2: the failure an operator
    // actually meets is a volume that mounted read-only or filled up, and a
    // read succeeds against both.
    const readOnly = await mkdtemp(join(tmpdir(), "reviewplane-status-ro-"));
    await chmod(readOnly, 0o500);
    try {
      const report = await gatherStatus({ pool: postgres.pool, artefactPath: join(readOnly, "artefacts") });
      assert.equal(report.artefact_store.available, false);
      assert.equal(report.status, "degraded");
      assert.ok(report.artefact_store.detail !== null);
    } finally {
      await chmod(readOnly, 0o755);
      await rm(readOnly, { recursive: true, force: true });
    }
  });

  test("a database that has gone away is reported without a connection string", async () => {
    const pool = createPool("postgres://reviewplane:hunter2@127.0.0.1:1/reviewplane");
    try {
      const report = await gatherStatus({ pool, artefactPath: artefactRoot });
      assert.equal(report.database.reachable, false);
      assert.equal(report.status, "degraded");
      const detail = report.database.detail ?? "";
      assert.ok(detail.length > 0, "the failure class is reported");
      // docs/SECURITY.md section 18: no credential and no address, in a report
      // an operator pastes into an issue.
      assert.ok(!detail.includes("hunter2"), `the password leaked into ${detail}`);
      assert.ok(!detail.includes("127.0.0.1:1"), `the address leaked into ${detail}`);
      // The whole command still answers: the version, the artefact store and
      // the certificate are exactly what a database outage does not affect.
      assert.equal(report.artefact_store.available, true);
      assert.equal(typeof report.version.version, "string");
    } finally {
      await pool.end().catch(() => undefined);
    }
  });

  test("it reports the expiry of the certificate a TLS listener actually serves", async () => {
    // A ninety-day certificate — the shape a human obtains and renews — so that
    // the warning below is the one an operator can act on. `now` is moved
    // eighty days forward rather than the certificate backdated, because what
    // is asserted is that the warning fires on a real certificate served by a
    // real listener rather than on a computed date.
    const authority = generateCertificateAuthority({
      commonName: "ReviewPlane Status Test CA",
      organization: "ReviewPlane",
      notAfter: new Date(Date.now() + 365 * 86_400_000),
    });
    const material = issueListenerCertificate({
      authority: { certificatePem: authority.certificatePem, privateKeyPem: authority.privateKeyPem },
      hosts: ["localhost"],
      organization: "ReviewPlane",
      notAfter: new Date(Date.now() + 90 * 86_400_000),
    });
    const server: Server = createServer(
      { cert: material.certificatePem, key: material.privateKeyPem },
      (_request, response) => {
        response.end("ok");
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");

    try {
      const fresh = await gatherStatus({
        pool: postgres.pool,
        artefactPath: artefactRoot,
        tlsEndpoint: `127.0.0.1:${String(address.port)}`,
        tlsServerName: "localhost",
      });
      assert.equal(fresh.certificate.checked, true, fresh.certificate.detail ?? "");
      assert.ok((fresh.certificate.validity_days ?? 0) > CERTIFICATE_WARNING_DAYS);
      assert.equal(fresh.certificate.warning, null, "a certificate with months left is not a warning");

      const later = await gatherStatus({
        pool: postgres.pool,
        artefactPath: artefactRoot,
        tlsEndpoint: `127.0.0.1:${String(address.port)}`,
        tlsServerName: "localhost",
        now: new Date(Date.now() + 80 * 86_400_000),
      });
      assert.ok((later.certificate.days_remaining ?? 99) < CERTIFICATE_WARNING_DAYS);
      assert.ok(
        later.warnings.some((warning) => warning.includes("expires in")),
        `expected an expiry warning, got ${JSON.stringify(later.warnings)}`,
      );
      // An expiring certificate is a warning, not a failure: the deployment is
      // still serving, and a status command that refused would be reporting a
      // problem it does not have yet.
      assert.equal(later.status, "ok");

      // Caddy's internal authority issues twelve-hour leaves and renews them
      // itself. Warning about those would fire on every healthy default
      // installation, every day, which is how an operator learns to stop
      // reading warnings.
      const shortLived = issueListenerCertificate({
        authority: {
          certificatePem: authority.certificatePem,
          privateKeyPem: authority.privateKeyPem,
        },
        hosts: ["localhost"],
        organization: "ReviewPlane",
        notAfter: new Date(Date.now() + 12 * 3_600_000),
      });
      const shortServer = createServer(
        { cert: shortLived.certificatePem, key: shortLived.privateKeyPem },
        (_request, response) => {
          response.end("ok");
        },
      );
      await new Promise<void>((resolve) => {
        shortServer.listen(0, "127.0.0.1", resolve);
      });
      const shortAddress = shortServer.address();
      assert.ok(shortAddress !== null && typeof shortAddress !== "string");
      try {
        const report = await gatherStatus({
          pool: postgres.pool,
          artefactPath: artefactRoot,
          tlsEndpoint: `127.0.0.1:${String(shortAddress.port)}`,
          tlsServerName: "localhost",
        });
        assert.equal(report.certificate.checked, true, report.certificate.detail ?? "");
        assert.equal(report.certificate.days_remaining, 0);
        assert.equal(report.certificate.warning, null, "a short-lived certificate is not warned about");
        assert.match(report.certificate.detail ?? "", /renewed automatically/u);
      } finally {
        await new Promise<void>((resolve) => {
          shortServer.close(() => {
            resolve();
          });
        });
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  test("an unreachable TLS endpoint is reported, not thrown", async () => {
    const report = await gatherStatus({
      pool: postgres.pool,
      artefactPath: artefactRoot,
      tlsEndpoint: "127.0.0.1:1",
    });
    assert.equal(report.certificate.checked, false);
    assert.ok((report.certificate.detail ?? "").length > 0);
    assert.equal(report.status, "ok");
  });

  test("a write probe that does not return is unavailability, not a hung command", async () => {
    // A filesystem call is not guaranteed to return: a wedged network mount
    // blocks in the kernel, and `mkdir` under some virtual filesystems does the
    // same. A status command that hung on the store it was asked about would be
    // useless in exactly the outage it exists for. Zero milliseconds makes the
    // race resolve on the timer deterministically, without needing a filesystem
    // that hangs to hand.
    const report = await gatherStatus({
      pool: postgres.pool,
      artefactPath: artefactRoot,
      artefactProbeTimeoutMs: 0,
    });
    assert.equal(report.artefact_store.available, false);
    assert.match(report.artefact_store.detail ?? "", /did not complete within 0ms/u);
    assert.equal(report.status, "degraded");
  });

  test("`status --json` prints the automation shape and `status` exits 4 when degraded", async () => {
    const ok = await runCliProcess(["status", "--json"], { artefactPath: artefactRoot });
    assert.equal(ok.code, 0, ok.stderr);

    const parsed: unknown = JSON.parse(ok.stdout);
    assert.ok(typeof parsed === "object" && parsed !== null);
    // `docs/OPERATIONS.md` section 14 makes `--json` an automation interface, so
    // the key set is asserted in full: a field that quietly changes name breaks
    // a script nobody is watching.
    assert.deepEqual(Object.keys(parsed), [
      "status",
      "version",
      "database",
      "artefact_store",
      "connectors",
      "browser_capacity",
      "sessions",
      "queue",
      "storage",
      "certificate",
      "warnings",
    ]);

    const readOnly = await mkdtemp(join(tmpdir(), "reviewplane-status-cli-ro-"));
    await chmod(readOnly, 0o500);
    try {
      const degraded = await runCliProcess(["status"], {
        artefactPath: join(readOnly, "artefacts"),
      });
      assert.equal(degraded.code, EXIT_STATUS_DEGRADED, degraded.stderr);
      assert.ok(degraded.stdout.includes("status: degraded"));
    } finally {
      await chmod(readOnly, 0o755);
      await rm(readOnly, { recursive: true, force: true });
    }
  });

  test("the command line runs when it is invoked through the symlink the image installs", async () => {
    // The image installs `/usr/local/bin/reviewplane -> /app/dist/cli.js`, and
    // the entry-point guard compared `process.argv[1]` with `import.meta.url`
    // without resolving either. They differ through a symlink, so the module
    // ran nothing and exited 0: `reviewplane migrate` applied no migration and
    // `reviewplane serve` started no server, both silently and both reported by
    // Docker as a container restarting with exit code 0.
    //
    // This asserts the shape the image actually uses, not the shape the test
    // runner happens to use, because the second is what passed while the first
    // was broken.
    const directory = await mkdtemp(join(tmpdir(), "reviewplane-cli-link-"));
    const link = join(directory, "reviewplane");
    try {
      await symlink(join(import.meta.dirname, "..", "src", "cli.ts"), link);
      const result = await runCliProcess(["version"], { entry: link });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^reviewplane /u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("byte counts are rendered in units an operator reads", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(null), "unknown");
  });
});

#!/usr/bin/env node
/**
 * `reviewplane` — the operator command line.
 *
 * `docs/DEPLOYMENT.md` section 11 requires the application to expose a
 * migration command, and `docs/ARCHITECTURE.md` section 4.2 names the process
 * roles one codebase may run. Both are here rather than in a shell script,
 * because a migration that runs from the application image is a migration that
 * cannot be applied by a build of the schema that does not match the code.
 *
 * ```text
 * reviewplane migrate             apply every pending migration
 * reviewplane migrate --status    report the schema version and what is pending
 * reviewplane migrate --preflight run the upgrade preflight and change nothing
 * reviewplane serve               the api role: HTTP API, connector listener
 * reviewplane jobs                the jobs role: durable background work
 * reviewplane install-token       mint the one-time administrator bootstrap token
 * reviewplane status [--json]     the deployment's health, capacity and storage
 * reviewplane backup --output F   write one archive of this installation
 * reviewplane restore --input F   restore an archive into an empty installation
 * reviewplane export-review       write one review as a portable document
 * reviewplane version             the build this image carries
 * ```
 *
 * `backup` and `restore` are here, in the operator command line inside the
 * image, and deliberately nowhere else. Restore is a privileged local
 * operation: it truncates and repopulates every table, and an HTTP route that
 * could do that would be an authorisation bug waiting to be found
 * (`docs/SECURITY.md` section 20). `apps/server/test/backup-security.test.ts`
 * asserts the API offers no such route.
 *
 * Exit codes are the operator interface: 0 success, 1 failure, 2 a
 * configuration error the process cannot start with, 3 for `migrate --status`
 * when migrations are pending — so a deployment script can branch on "needs
 * migrating" without parsing output — and 4 for a command that ran correctly
 * and found a bad answer: a degraded `status`, a failed `migrate --preflight`,
 * or a `restore` that completed with evidence missing.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";

import type { BackupMode } from "@reviewplane/protocol/platform";

import { buildApp } from "./app.ts";
import { ConfigurationError, loadServerConfig } from "./config.ts";
import { migrate, migrationReport, migrationState } from "./db/migrate.ts";
import { createPool, type Pool } from "./db/pool.ts";
import { readBuildInfo, registerHealthRoutes } from "./health.ts";
import { JobRunner } from "./jobs/runner.ts";
import {
  DEFAULT_ARTEFACT_PATH,
  loadArtefactStoreConfig,
  loadRetentionWindows,
} from "./modules/artefacts/config.ts";
import { spoolToFile } from "./modules/backup/archive.ts";
import { createBackup } from "./modules/backup/backup.ts";
import { renderPreflight, runPreflight } from "./modules/backup/preflight.ts";
import { restoreBackup } from "./modules/backup/restore.ts";
import { artefactJobHandlers } from "./modules/artefacts/jobs.ts";
import { ArtefactService } from "./modules/artefacts/service.ts";
import { createArtefactStore } from "./modules/artefacts/store/index.ts";
import { InstallTokenStore } from "./modules/identity/install-tokens.ts";
import { OrganisationStore } from "./modules/identity/organisations.ts";
import { UserStore } from "./modules/identity/users.ts";
import { gatherStatus, renderStatus } from "./modules/operations/status.ts";
import { ReviewService } from "./modules/reviews/service.ts";

/** Exit code for `migrate --status` when the schema is behind the code. */
export const EXIT_MIGRATIONS_PENDING = 3;

/**
 * Exit code for `status` when a check the deployment cannot work without has
 * failed: the database, the schema or the artefact store.
 *
 * It is deliberately not `1`. `1` is "the command itself failed"; this is "the
 * command succeeded and the answer is bad", and a monitoring script has to be
 * able to tell those apart.
 */
export const EXIT_STATUS_DEGRADED = 4;

/**
 * Exit code for a command that ran correctly and found a bad answer.
 *
 * It is the same value as {@link EXIT_STATUS_DEGRADED} and means the same
 * thing: a failed upgrade preflight and a restore that finished with evidence
 * missing are both "the command succeeded and the answer is bad", which a
 * monitoring script has to be able to tell from "the command failed".
 */
export const EXIT_CHECK_FAILED = EXIT_STATUS_DEGRADED;

const USAGE = `reviewplane <command>

  migrate [--status] [--preflight] [--json]
                       apply pending database migrations, report them, or run
                       the upgrade preflight of docs/OPERATIONS.md section 12
  serve                run the api role
  jobs [--once]        run the jobs role, serving /health/live, /health/ready
                       and /version on REVIEWPLANE_JOBS_HEALTH_PORT (8081)
  install-token [--ttl-seconds N]
                       mint the one-time administrator bootstrap token and print
                       it once; it is single-use and expires (default 24 hours)
  status [--json]      report version, database and schema, artefact store,
                       connectors, browser capacity, sessions, queue depth,
                       storage use and certificate expiry
  connector list       report the enrolled connectors, their environments and
                       their connection health
  backup --output FILE|- [--mode full|database] [--include-key-material] [--json]
                       write one archive of this installation: the database and,
                       under the filesystem driver, the artefact objects.
                       - writes it to standard output. Key material is excluded
                       unless --include-key-material
  restore --input FILE|- [--dry-run] [--hostname HOST] [--json]
                       restore an archive into an empty installation; - reads it
                       from standard input. --dry-run verifies the archive and
                       reports the plan without writing anything
  export-review --project <id|slug> --review <slug|id> [--out FILE]
                       write one review as the portable document of
                       docs/REVIEW_FORMAT.md, to FILE or to standard output
  version              print the build information

Configuration is read from the environment; see docs/CONFIGURATION.md.
`;

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function runMigrate(pool: Pool, argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");

  // The preflight of `docs/OPERATIONS.md` section 12, which is step 5 of the
  // upgrade sequence in `docs/DEPLOYMENT.md` section 15. It reads and reports;
  // it applies nothing, so an operator can run it as often as they like.
  if (argv.includes("--preflight")) {
    const report = await runPreflight({
      pool,
      artefactPath: artefactPathSetting(),
      ...(process.env["REVIEWPLANE_CONNECTOR_MINIMUM_VERSION"] === undefined
        ? {}
        : { minimumConnectorVersion: process.env["REVIEWPLANE_CONNECTOR_MINIMUM_VERSION"] }),
      ...(process.env["REVIEWPLANE_CONNECTOR_RECOMMENDED_VERSION"] === undefined
        ? {}
        : { recommendedConnectorVersion: process.env["REVIEWPLANE_CONNECTOR_RECOMMENDED_VERSION"] }),
    });
    write(json ? JSON.stringify(report, null, 2) : renderPreflight(report));
    return report.ok ? 0 : EXIT_CHECK_FAILED;
  }

  if (argv.includes("--status")) {
    const report = await migrationReport(pool);
    if (json) {
      write(JSON.stringify(report, null, 2));
      return report.pending.length === 0 ? 0 : EXIT_MIGRATIONS_PENDING;
    }
    write(`schema version: ${report.schema_version ?? "(none applied)"}`);
    write(`applied:        ${String(report.applied.length)}`);
    write(`pending:        ${String(report.pending.length)}`);
    for (const record of report.pending) {
      write(`  pending  ${record.filename}  downgrade ${record.downgrade}`);
    }
    // `docs/DEPLOYMENT.md` section 15: a migration must state whether downgrade
    // is supported, and the moment an operator needs to know is before they
    // apply it — because the answer decides whether the pre-upgrade backup is
    // the only way back.
    const irreversible = report.pending.filter((record) => record.downgrade === "not_supported");
    if (irreversible.length > 0) {
      write("");
      write(
        `${String(irreversible.length)} of ${String(report.pending.length)} pending migration(s) declare no downgrade; keep the pre-upgrade backup until the new version is validated.`,
      );
    }
    return report.pending.length === 0 ? 0 : EXIT_MIGRATIONS_PENDING;
  }

  const before = await migrationState(pool);
  if (before.pending.length === 0) {
    write(`schema version: ${before.schemaVersion ?? "(none applied)"}`);
    write("nothing to apply");
    return 0;
  }
  write(`applying ${String(before.pending.length)} migration(s)`);
  const result = await migrate(pool);
  for (const file of result.applied) write(`  applied  ${file}`);
  const after = await migrationState(pool);
  write(`schema version: ${after.schemaVersion ?? "(none applied)"}`);
  if (after.pending.length > 0) {
    process.stderr.write(
      `migrate finished with ${String(after.pending.length)} migration(s) still pending\n`,
    );
    return 1;
  }
  return 0;
}

async function runServe(pool: Pool): Promise<number> {
  const config = loadServerConfig();
  // Migrations run before the listener opens. A process that served requests
  // while its schema was behind its code would fail request by request, which
  // is worse than not starting; `/health/ready` reports the same condition for
  // a deployment that migrates separately.
  const migration = await migrate(pool);
  const built = await buildApp({ config, pool, runJobs: serveRunsJobs() });
  built.app.log.info(
    { applied: migration.applied.length, already_applied: migration.alreadyApplied.length },
    "migrations complete",
  );
  await built.start();
  await waitForSignal(async () => {
    await built.stop();
  });
  return 0;
}

/**
 * How often the role re-checks whether the schema has caught up with its code.
 *
 * A deployment that migrates in a separate step starts this process against a
 * schema that is briefly behind. Exiting would leave an orchestrator restarting
 * it in a loop; claiming jobs would run handlers against a database their code
 * does not match. So it starts, reports itself not ready, and begins work when
 * the schema is current.
 */
const SCHEMA_RECHECK_INTERVAL_MS = 5_000;

/**
 * The artefact service the `jobs` and `status` roles need.
 *
 * It reads the artefact module's own configuration and **not** the whole
 * `ServerConfig`, for the reason `requireDatabaseUrl` below gives about
 * `migrate`: neither role has a gateway, a worker credential or a capability
 * key, and requiring them would make a background worker refuse to start over
 * settings it never uses. The variables are the same ones the API role reads,
 * so a thumbnail written by the jobs container lands in exactly the store the
 * API container serves from.
 */
function artefactService(pool: Pool): ArtefactService {
  const storeConfig = loadArtefactStoreConfig(process.env);
  return new ArtefactService(pool, createArtefactStore(storeConfig), storeConfig.maxBytes, {
    retention: loadRetentionWindows(process.env),
  });
}



async function runJobs(pool: Pool, once: boolean): Promise<number> {
  const runner = new JobRunner({
    pool,
    handlers: artefactJobHandlers(artefactService(pool)),
    logger: {
      info: (fields, message) => {
        write(`${message} ${JSON.stringify(fields)}`);
      },
      error: (fields, message) => {
        process.stderr.write(`${message} ${JSON.stringify(fields)}\n`);
      },
    },
  });

  if (once) {
    const state = await migrationState(pool);
    if (state.pending.length > 0) {
      process.stderr.write(
        `a one-shot run will not claim jobs against a schema with ${String(state.pending.length)} pending migration(s); run reviewplane migrate first\n`,
      );
      return 1;
    }
    const done = await runner.drain();
    write(`ran ${String(done)} job(s)`);
    return 0;
  }

  // `docs/OPERATIONS.md` section 2 requires every service to expose the three
  // endpoints, and this role is a service: without a listener an operator has
  // no way to ask whether background work is being done, which is exactly the
  // question readiness exists to answer. The listener serves health alone.
  const health = Fastify({ logger: false });
  let claiming = false;
  registerHealthRoutes(health, {
    role: "jobs",
    pool,
    checks: [
      {
        name: "job_runner",
        run: async () =>
          Promise.resolve(
            claiming
              ? { ready: true, detail: `claiming as ${runner.runnerId}` }
              : { ready: false, detail: "waiting for the schema to reach this build" },
          ),
      },
    ],
  });
  const host = jobsHealthHost();
  await health.listen({ host, port: jobsHealthPort() });
  // The bound host, not Fastify's rendered address: `listen` formats a
  // wildcard bind as a loopback URL, and an operator reading
  // "http://127.0.0.1:8081" would conclude the probe is unreachable from
  // outside the container when it is in fact reachable from anywhere.
  const bound = health.server.address();
  const boundPort = bound === null || typeof bound === "string" ? jobsHealthPort() : bound.port;
  write(`jobs role health endpoints on ${host}:${String(boundPort)}`);

  const startWhenMigrated = async (): Promise<boolean> => {
    const state = await migrationState(pool).catch(() => null);
    if (state === null || state.pending.length > 0) return false;
    runner.start();
    claiming = true;
    write(`jobs role claiming as ${runner.runnerId}`);
    return true;
  };

  let recheck: NodeJS.Timeout | null = null;
  if (!(await startWhenMigrated())) {
    write("jobs role is not ready: the schema is behind this build; run reviewplane migrate");
    recheck = setInterval(() => {
      void startWhenMigrated().then((started) => {
        if (started && recheck !== null) {
          clearInterval(recheck);
          recheck = null;
        }
      });
    }, SCHEMA_RECHECK_INTERVAL_MS);
    recheck.unref();
  }

  await waitForSignal(async () => {
    if (recheck !== null) clearInterval(recheck);
    await runner.stop();
    await health.close();
  });
  return 0;
}

/**
 * Mints the one-time administrator bootstrap token
 * (`docs/SECURITY.md` section 6.1, `docs/DEPLOYMENT.md` section 6).
 *
 * It prints the token once, to standard output, and the control plane keeps
 * only its digest. An operator who loses it mints another; the outstanding one
 * still expires on its own, because a token that waited for ever on a console
 * scrollback would be a permanent way in.
 *
 * It refuses to mint a second token for an account that already has a
 * credential. Re-bootstrapping is a password reset, and a reset that anybody
 * with database access can trigger silently is not one this command should
 * offer by accident.
 */
async function runInstallToken(pool: Pool, argv: readonly string[], force: boolean): Promise<number> {
  const state = await migrationState(pool);
  if (state.pending.length > 0) {
    process.stderr.write(
      `the schema is behind this build (${String(state.pending.length)} migration(s) pending); run reviewplane migrate first\n`,
    );
    return 1;
  }

  const organisations = new OrganisationStore(pool);
  const organisation = await organisations.primary();
  if (organisation === null) {
    process.stderr.write("this deployment has no organisation; run reviewplane migrate first\n");
    return 1;
  }
  const users = new UserStore(pool);
  const user = await users.sole(organisation.id);
  if (user === null) {
    process.stderr.write("this deployment has no user record; run reviewplane migrate first\n");
    return 1;
  }
  if (user.passwordHash !== null && !force) {
    process.stderr.write(
      "this installation already has an administrator credential; pass --force to mint a reset token\n",
    );
    return 1;
  }

  const ttl = readTtlSeconds(argv);
  const issued = await new InstallTokenStore(pool).issue({
    organisationId: organisation.id,
    userId: user.id,
    ...(ttl === undefined ? {} : { ttlSeconds: ttl }),
  });

  write("administrator install token (shown once):");
  write("");
  write(`  ${issued.token}`);
  write("");
  write(`expires at ${issued.expiresAt.toISOString()}`);
  write("Open the web application and complete the first-run screen with it.");
  return 0;
}

/**
 * `reviewplane status` (`docs/OPERATIONS.md` section 3).
 *
 * It runs from the application image, so it reports the deployment the image is
 * part of rather than whatever an operator's shell can reach: the database it
 * is configured with, the artefact volume it has mounted, and the TLS listener
 * it can see over the internal network. `deploy/compose/reviewplane` is the
 * wrapper that runs it in the `api` container.
 */
async function runStatus(pool: Pool, json: boolean): Promise<number> {
  const report = await gatherStatus({
    pool,
    artefactPath: process.env["REVIEWPLANE_ARTEFACT_PATH"] ?? "/var/lib/reviewplane/artefacts",
    tlsEndpoint: process.env["REVIEWPLANE_STATUS_TLS_ENDPOINT"],
    tlsServerName: process.env["REVIEWPLANE_GATEWAY_DOMAIN"],
  });
  write(json ? JSON.stringify(report, null, 2) : renderStatus(report));
  return report.status === "ok" ? 0 : EXIT_STATUS_DEGRADED;
}

/**
 * `reviewplane export-review` (`docs/API.md` section 12,
 * `docs/REVIEW_FORMAT.md`).
 *
 * The operator half of the export. The HTTP route queues a durable job and
 * stores an artefact, which is right for a reviewer clicking a button; an
 * operator with shell access on the control plane wants the document itself,
 * on standard output or in a file, without an artefact grant to fetch it back
 * through.
 *
 * It builds the same document the job builds, from the same code, so the two
 * cannot drift. It writes no artefact and no event: nothing changed, and an
 * export that only read rows is not a state change to audit. Reading the review
 * through the API — which does leave a record — is the auditable path.
 */
async function runExportReview(pool: Pool, argv: readonly string[]): Promise<number> {
  const projectRef = readOption(argv, "--project");
  const reviewRef = readOption(argv, "--review");
  if (projectRef === undefined || reviewRef === undefined) {
    process.stderr.write("export-review requires --project and --review\n");
    return 1;
  }

  const project = await pool.query<{ id: string; organisation_id: string }>(
    "select id, organisation_id from projects where id = $1 or slug = $1",
    [projectRef],
  );
  const projectRow = project.rows[0];
  if (projectRow === undefined) {
    process.stderr.write(`no project matches ${projectRef}\n`);
    return 1;
  }
  const scope = { organisationId: projectRow.organisation_id, projectId: projectRow.id };

  const review = await pool.query<{ id: string }>(
    `select id from reviews
      where organisation_id = $1 and project_id = $2 and (id = $3 or slug = $3)
      order by created_at desc
      limit 1`,
    [scope.organisationId, scope.projectId, reviewRef],
  );
  const reviewRow = review.rows[0];
  if (reviewRow === undefined) {
    process.stderr.write(`no review matches ${reviewRef} in ${projectRow.id}\n`);
    return 1;
  }

  // The whole server configuration is deliberately not loaded. This command
  // reads rows and writes a file; it has no gateway, no worker and no
  // capability key, exactly as `migrate` does not. The artefact store is
  // constructed because `ReviewService` takes one, and it is never touched: the
  // metadata-only document carries digests and no bytes.
  const artefacts = new ArtefactService(
    pool,
    createArtefactStore(loadArtefactStoreConfig(process.env)),
    1,
  );
  const document = await new ReviewService(pool, artefacts).buildExportDocument(
    scope,
    reviewRow.id,
  );
  const rendered = `${JSON.stringify(document, null, 2)}\n`;
  const out = readOption(argv, "--out");
  if (out === undefined) {
    process.stdout.write(rendered);
    return 0;
  }
  await writeFile(out, rendered, { mode: 0o600 });
  write(`wrote ${out}`);
  write(`sha256 ${createHash("sha256").update(rendered, "utf8").digest("hex")}`);
  return 0;
}

/**
 * The artefact-store root this installation is configured with.
 *
 * Read here rather than through `loadServerConfig` for the reason `migrate`
 * gives: an operator taking a backup has no gateway, no worker credential and
 * no capability key, and requiring them would make a backup impossible in the
 * outage a backup is for.
 */
function artefactPathSetting(): string {
  return process.env["REVIEWPLANE_ARTEFACT_PATH"] ?? DEFAULT_ARTEFACT_PATH;
}

function artefactDriverSetting(): "filesystem" | "s3" {
  const raw = process.env["REVIEWPLANE_ARTEFACT_DRIVER"] ?? "filesystem";
  if (raw !== "filesystem" && raw !== "s3") {
    throw new ConfigurationError("REVIEWPLANE_ARTEFACT_DRIVER must be filesystem or s3.");
  }
  return raw;
}

/**
 * `reviewplane backup` (`docs/DEPLOYMENT.md` section 16).
 *
 * The default mode is `full` under the `filesystem` driver, because ADR-0012
 * makes a complete single-host backup exactly one database plus one directory
 * and a default that carried only half of it would be a default that loses
 * evidence. An installation running the `s3` driver has no artefact volume to
 * read, so it takes `--mode database` and protects the bucket separately.
 */
async function runBackup(pool: Pool, argv: readonly string[]): Promise<number> {
  const output = readOption(argv, "--output");
  if (output === undefined) {
    process.stderr.write("backup requires --output FILE\n");
    return 1;
  }
  const requested = readOption(argv, "--mode");
  if (requested !== undefined && requested !== "full" && requested !== "database") {
    process.stderr.write("--mode must be full or database\n");
    return 1;
  }
  const driver = artefactDriverSetting();
  const mode: BackupMode = requested ?? (driver === "filesystem" ? "full" : "database");
  const json = argv.includes("--json");

  // `-` streams the archive to standard output. It is the form that works in a
  // container: `deploy/compose/reviewplane` runs this through
  // `docker compose exec -T`, so the bytes arrive in the operator's own shell
  // redirection on the host rather than in a volume they then have to copy the
  // file out of (`docs/DEPLOYMENT.md` section 16).
  const streaming = output === "-";
  if (streaming && json) {
    process.stderr.write("--output - and --json both write to standard output; choose one\n");
    return 1;
  }

  const result = await createBackup({
    pool,
    output: streaming ? { stream: process.stdout } : resolvePath(output),
    mode,
    includeKeyMaterial: argv.includes("--include-key-material"),
    artefactPath: artefactPathSetting(),
    artefactDriver: driver,
    // The warning and the progress lines go to standard error so that `--json`
    // is a document on standard output and nothing else.
    log: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });

  if (json) {
    write(
      JSON.stringify(
        {
          archive: result.archive,
          bytes: result.bytes,
          sha256: result.sha256,
          manifest: result.manifest,
        },
        null,
        2,
      ),
    );
  } else if (streaming) {
    // Standard output carries the archive, so the report goes to standard
    // error. An operator running `> file.tar.zst` still sees it.
    process.stderr.write(
      [
        `wrote ${String(result.bytes)} byte(s) to standard output`,
        `mode            ${result.manifest.mode}`,
        `schema version  ${result.manifest.schema_version}`,
        `artefacts       ${String(result.manifest.artefact_objects)} object(s)`,
        `key material    ${result.manifest.key_material.included ? "INCLUDED" : "excluded"}`,
        `sha256          ${result.sha256}`,
        "",
      ].join("\n"),
    );
  } else {
    write(`wrote ${result.archive ?? "(stream)"}`);
    write(`mode            ${result.manifest.mode}`);
    write(`schema version  ${result.manifest.schema_version}`);
    write(
      `rows            ${String(result.manifest.tables.reduce((total, table) => total + table.rows, 0))} in ${String(result.manifest.tables.length)} table(s)`,
    );
    write(
      `artefacts       ${String(result.manifest.artefact_objects)} object(s), ${String(result.manifest.artefact_bytes)} byte(s)`,
    );
    write(`key material    ${result.manifest.key_material.included ? "INCLUDED" : "excluded"}`);
    write(`size            ${String(result.bytes)} byte(s)`);
    write(`sha256          ${result.sha256}`);
  }

  if (result.missingArtefacts.length > 0) {
    process.stderr.write(
      `${String(result.missingArtefacts.length)} artefact(s) referenced by metadata were not in the store and are recorded in the manifest as missing\n`,
    );
    return EXIT_CHECK_FAILED;
  }
  return 0;
}

/**
 * `reviewplane restore` (`docs/DEPLOYMENT.md` section 17).
 *
 * It refuses more than it accepts, on purpose. The archive is verified against
 * its manifest before anything is written, the target must be an empty
 * installation, and a restore that finishes with an artefact its metadata
 * references missing exits 4 rather than 0 — a restored review that cannot show
 * its evidence is not a successful restore.
 */
async function runRestore(pool: Pool, argv: readonly string[]): Promise<number> {
  const input = readOption(argv, "--input");
  if (input === undefined) {
    process.stderr.write("restore requires --input FILE\n");
    return 1;
  }
  const hostname = readOption(argv, "--hostname");
  const json = argv.includes("--json");
  const lines: string[] = [];

  // `-` reads the archive from standard input, which is how an archive that
  // lives on the host reaches a command running in a container. It is spooled
  // to a file first, because a restore reads its archive twice on purpose —
  // once to prove it, once to apply it — and standard input can only be read
  // once. The spool goes beside the artefact store because that is the writable
  // volume this container has and the one already sized for the evidence the
  // archive carries.
  const spoolDirectory = join(artefactPathSetting(), ".restore");
  const spool = input === "-" ? join(spoolDirectory, `incoming-${String(process.pid)}.tar.zst`) : null;
  if (spool !== null) {
    await mkdir(spoolDirectory, { recursive: true });
    const bytes = await spoolToFile(process.stdin, spool);
    process.stderr.write(`read ${String(bytes)} byte(s) from standard input\n`);
  }

  try {
    const result = await restoreBackup({
      pool,
      archive: spool ?? resolvePath(input),
      artefactPath: artefactPathSetting(),
      dryRun: argv.includes("--dry-run"),
      ...(hostname === undefined ? {} : { hostname }),
      log: (line) => {
        lines.push(line);
        if (!json) write(line);
      },
    });

    if (json) {
      write(
        JSON.stringify(
          {
            applied: result.applied,
            manifest: result.plan.manifest,
            rows: result.plan.rows,
            artefact_objects: result.plan.artefactObjects,
            migrations_to_apply: result.plan.migrationsToApply,
            migrations_pending_after: result.plan.migrationsPendingAfter,
            blockers: result.plan.blockers,
            missing_artefacts: result.missingArtefacts,
            connectors_needing_re_enrolment: result.connectorsNeedingReEnrolment,
            invalidated: result.invalidated,
            notes: lines,
          },
          null,
          2,
        ),
      );
    }

    if (!result.applied) {
      // A dry run that found a blocker has answered its question correctly and
      // the answer is bad, which is what 4 means.
      return result.plan.blockers.length === 0 ? 0 : EXIT_CHECK_FAILED;
    }
    return result.missingArtefacts.length > 0 && result.plan.manifest.mode === "full"
      ? EXIT_CHECK_FAILED
      : 0;
  } finally {
    // The spool is a copy of the archive: it holds every review, every
    // annotation and every screenshot the installation has. It does not stay
    // on the volume once the restore has read it, whether or not it succeeded.
    if (spool !== null) await rm(spool, { force: true });
  }
}

/** Reads `--name value` from an argument list. */
function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function readTtlSeconds(argv: readonly string[]): number | undefined {
  const index = argv.indexOf("--ttl-seconds");
  if (index === -1) return undefined;
  const raw = argv[index + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError("--ttl-seconds must be a positive whole number of seconds.");
  }
  return value;
}

/**
 * `reviewplane connector list` (`docs/API.md` §9, `docs/OPERATIONS.md`).
 *
 * The same facts the connector health screen shows, for an operator who has a
 * shell and no browser — which is the state a deployment is in while the first
 * connector is being enrolled. It reads; it never revokes, because revocation
 * is an authorised, audited action and a command that took no credential could
 * not record who performed it.
 */
async function runConnectorList(pool: Pool, argv: readonly string[]): Promise<number> {
  if (argv[0] !== "list") {
    process.stderr.write(`unknown connector command: ${argv[0] ?? "(none)"}\n\nreviewplane connector list\n`);
    return 1;
  }
  const state = await migrationState(pool);
  if (state.pending.length > 0) {
    process.stderr.write(
      `the schema is behind this build (${String(state.pending.length)} migration(s) pending); run reviewplane migrate first\n`,
    );
    return 1;
  }

  const rows = await pool.query<{
    id: string;
    status: string;
    version: string;
    capabilities: string[];
    connected_at: Date | null;
    last_heartbeat_at: Date | null;
    revoked_at: Date | null;
    environment_id: string;
    environment_name: string;
    platform: string;
    architecture: string;
    project_id: string | null;
    workspaces: string;
  }>(
    `select c.id, c.status, c.version, c.capabilities, c.connected_at, c.last_heartbeat_at,
            c.revoked_at, c.environment_id, e.name as environment_name, e.platform, e.architecture,
            c.project_id,
            (select count(*)::text from workspaces w where w.environment_id = e.id) as workspaces
       from connectors c
       join environments e on e.id = c.environment_id
      order by c.created_at desc
      limit 200`,
  );

  if (rows.rows.length === 0) {
    write("no connector is enrolled");
    write("");
    write("Mint an enrolment token from the web application, or with the API of docs/API.md section 9,");
    write("then run reviewplane-connector enrol on the development machine.");
    return 0;
  }

  const instant = (value: Date | null): string => (value === null ? "-" : value.toISOString());
  for (const row of rows.rows) {
    write(`${row.id}  ${row.status}`);
    write(`  environment    ${row.environment_name} (${row.environment_id})`);
    write(`  platform       ${row.platform}/${row.architecture}`);
    write(`  project        ${row.project_id ?? "(organisation-wide)"}`);
    write(`  version        ${row.version}`);
    write(`  capabilities   ${row.capabilities.join(", ") || "(none)"}`);
    write(`  connected at   ${instant(row.connected_at)}`);
    write(`  last heartbeat ${instant(row.last_heartbeat_at)}`);
    if (row.revoked_at !== null) write(`  revoked at     ${instant(row.revoked_at)}`);
    write(`  workspaces     ${row.workspaces}`);
    write("");
  }
  return 0;
}

/**
 * Whether `reviewplane serve` runs the jobs role beside the API.
 *
 * `docs/ARCHITECTURE.md` section 4.2 gives one codebase two ways to run
 * background work: beside the API in a single-container deployment, or alone in
 * a container of its own. Both runners are safe together — a claim is
 * `SELECT ... FOR UPDATE SKIP LOCKED`, so two of them never take the same row —
 * but "safe" is not the point. A deployment that runs a `jobs` container and
 * also runs the role inside `api` has a `jobs` container whose readiness and
 * logs describe only some of the work being done, which is precisely the
 * question `docs/OPERATIONS.md` section 2 says readiness exists to answer.
 *
 * The default is on, because the default is one container.
 */
function serveRunsJobs(): boolean {
  const raw = process.env["REVIEWPLANE_SERVE_RUNS_JOBS"];
  if (raw === undefined || raw === "") return true;
  if (raw === "true" || raw === "false") return raw === "true";
  throw new ConfigurationError("REVIEWPLANE_SERVE_RUNS_JOBS must be true or false.");
}

/** Listen address for the jobs role's health endpoints. */
function jobsHealthHost(): string {
  return process.env["REVIEWPLANE_JOBS_HEALTH_HOST"] ?? "0.0.0.0";
}

function jobsHealthPort(): number {
  const raw = process.env["REVIEWPLANE_JOBS_HEALTH_PORT"];
  if (raw === undefined || raw === "") return 8081;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new ConfigurationError("REVIEWPLANE_JOBS_HEALTH_PORT must be a port number.");
  }
  return parsed;
}

/** Resolves when the process is asked to stop, after running `shutdown`. */
async function waitForSignal(shutdown: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      write(`shutting down on ${signal}`);
      void shutdown()
        .catch(() => undefined)
        .then(() => {
          resolve();
        });
    };
    process.on("SIGINT", () => {
      stop("SIGINT");
    });
    process.on("SIGTERM", () => {
      stop("SIGTERM");
    });
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "help" || command === "--help") {
    write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === "version") {
    const build = readBuildInfo();
    write(`reviewplane ${build.version}`);
    write(`revision ${build.revision}`);
    write(`built at ${build.builtAt}`);
    return 0;
  }

  const databaseUrl = requireDatabaseUrl();
  const pool = createPool(databaseUrl);
  try {
    switch (command) {
      case "migrate":
        return await runMigrate(pool, rest);
      case "backup":
        return await runBackup(pool, rest);
      case "restore":
        return await runRestore(pool, rest);
      case "serve":
        return await runServe(pool);
      case "jobs":
        return await runJobs(pool, rest.includes("--once"));
      case "status":
        return await runStatus(pool, rest.includes("--json"));
      case "install-token":
        return await runInstallToken(pool, rest, rest.includes("--force"));
      case "connector":
        return await runConnectorList(pool, rest);
      case "export-review":
        return await runExportReview(pool, rest);
      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * The one setting every command needs.
 *
 * `migrate` must run without the rest of the server's configuration — an
 * operator applying a schema has no gateway, no worker and no capability key —
 * so it reads the database URL directly rather than loading the whole
 * `ServerConfig`.
 */
function requireDatabaseUrl(): string {
  const direct = process.env["REVIEWPLANE_DATABASE_URL"];
  if (direct !== undefined && direct !== "") return direct;
  const file = process.env["REVIEWPLANE_DATABASE_URL_FILE"];
  if (file !== undefined && file !== "") return readFileSync(file, "utf8").trim();
  throw new ConfigurationError(
    "REVIEWPLANE_DATABASE_URL or REVIEWPLANE_DATABASE_URL_FILE must be set.",
  );
}

async function runCli(): Promise<void> {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Whether this module was invoked as the process entry point.
 *
 * The comparison is between **real** paths, and that is the whole point. The
 * image installs the operator command line as a symlink —
 * `/usr/local/bin/reviewplane -> /app/dist/cli.js` — so `process.argv[1]` is
 * the link and `import.meta.url` is its target, because Node resolves symlinks
 * when it loads a module. Comparing them without resolving therefore found them
 * unequal, ran nothing, and exited 0: `reviewplane migrate` in a deployed
 * container printed no output and applied no migration, and `reviewplane serve`
 * started no server, both silently. `docker compose up` reported it as a
 * container that keeps restarting with exit code 0.
 *
 * Resolving is also what keeps the test suite able to import `main` without the
 * module running for it, which is why the guard exists at all.
 */
function invokedAsEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(resolvePath(entry)) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedAsEntryPoint()) {
  await runCli();
}

/**
 * The security properties of backup and restore
 * (`docs/SECURITY.md` §20, `docs/TESTING.md` §10 and the mandatory negative
 * tests of RVP-56).
 *
 * These are separated from `backup.test.ts` because they are the tests that
 * must not be allowed to pass by accident. Three claims are made in the
 * documentation and each is asserted against the thing that enforces it:
 *
 *   * restore is a privileged local operation and is reachable through no
 *     network interface — asserted by enumerating every route the control
 *     plane registers, not by trying a handful of guessed paths;
 *   * key material is absent unless the operator explicitly opted in — asserted
 *     by searching the archive's bytes;
 *   * the opt-in warns and audits — asserted against the exact warning and the
 *     recorded event.
 *
 * The first is the one worth the most: an HTTP route that could truncate and
 * repopulate every table would be an authorisation bug with the blast radius of
 * the whole installation, and "we did not write one" is a claim that only stays
 * true if something checks.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { readArchive } from "../src/modules/backup/archive.ts";
import { createBackup, KEY_MATERIAL_WARNING } from "../src/modules/backup/backup.ts";
import { startHarness, type Harness } from "./support/harness.ts";

let harness: Harness;
let workspace: string;

before(async () => {
  harness = await startHarness();
  workspace = await mkdtemp(join(tmpdir(), "reviewplane-backup-security-"));
});

after(async () => {
  await harness?.stop();
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

describe("restore is not reachable over the network", () => {
  test("no registered route mentions backup or restore", () => {
    // Fastify's own route table, so a route added under any prefix — `/api`,
    // `/internal`, a plugin's — is in scope. Guessing paths would prove only
    // that the paths guessed do not exist.
    const printed = harness.built.app.printRoutes({ commonPrefix: false });
    assert.doesNotMatch(
      printed,
      /restore|backup/iu,
      `the control plane registers a route naming backup or restore:\n${printed}`,
    );
  });

  test("the paths an operator or an attacker would try are refused", async () => {
    for (const path of [
      "/api/v1/restore",
      "/api/v1/backup",
      "/api/v1/backups",
      "/api/v1/admin/restore",
      "/internal/restore",
      "/restore",
    ]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
        const response = await harness.built.app.inject({ method, url: path });
        assert.equal(
          response.statusCode,
          404,
          `${method} ${path} answered ${String(response.statusCode)} rather than 404`,
        );
      }
    }
  });

  test("the MCP surface exposes no backup or restore tool", async () => {
    // The agent-facing surface matters separately: `docs/MCP_SPEC.md` gives an
    // agent no operational authority at all, and a restore tool would hand it
    // the installation.
    const source = await readFile(
      join(import.meta.dirname, "..", "..", "mcp-server", "src", "tools.ts"),
      "utf8",
    );
    assert.ok(source.length > 0, "the MCP tool table could not be read");
    assert.doesNotMatch(source, /"(backup|restore)[_a-z]*"/u, "an MCP tool names backup or restore");
  });
});

describe("key material", () => {
  test("is absent from a default archive and present only on the opt-in", async () => {
    await harness.pool.query("delete from connector_tls_material");
    await harness.pool.query(
      `insert into connector_tls_material (purpose, certificate_pem, private_key_pem, not_after)
       values ('certificate_authority', 'cert', $1, now() + interval '365 days')`,
      ["the-authority-private-key"],
    );

    const store = join(workspace, "store");
    await mkdir(store, { recursive: true });

    const plain = await createBackup({
      pool: harness.pool,
      output: join(workspace, "default.tar.zst"),
      mode: "full",
      artefactPath: store,
      artefactDriver: "filesystem",
      environment: {},
    });
    assert.equal(plain.manifest.key_material.included, false);
    assert.ok(!(await contains(archivePath(plain), "the-authority-private-key")));

    const printed: string[] = [];
    const portable = await createBackup({
      pool: harness.pool,
      output: join(workspace, "portable.tar.zst"),
      mode: "full",
      includeKeyMaterial: true,
      artefactPath: store,
      artefactDriver: "filesystem",
      environment: {},
      log: (line) => printed.push(line),
    });
    assert.equal(portable.manifest.key_material.included, true);
    assert.ok(await contains(archivePath(portable), "the-authority-private-key"));

    const warning = printed.join("\n");
    assert.ok(warning.includes(KEY_MATERIAL_WARNING), "the opt-in printed no warning");
    assert.match(warning, /WARNING/u);
    assert.match(warning, /private key/u);

    const events = await harness.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from events where type = 'backup.created' order by recorded_at",
    );
    assert.deepEqual(
      events.rows.map((row) => row.payload["key_material_included"]),
      [false, true],
      "the audit trail does not record which archive carried key material",
    );
  });

  test("the archive and the audit event carry no credential value", async () => {
    const store = join(workspace, "store-2");
    await mkdir(store, { recursive: true });
    const result = await createBackup({
      pool: harness.pool,
      output: join(workspace, "configured.tar.zst"),
      mode: "full",
      artefactPath: store,
      artefactDriver: "filesystem",
      environment: {
        REVIEWPLANE_DATABASE_URL: "postgres://reviewplane:hunter2@postgres:5432/reviewplane",
        REVIEWPLANE_CAPABILITY_KEY: "capability-key-value",
        REVIEWPLANE_GATEWAY_DOMAIN: "reviews.example",
      },
    });
    assert.ok(!(await contains(archivePath(result), "hunter2")));
    assert.ok(!(await contains(archivePath(result), "capability-key-value")));
    assert.ok(await contains(archivePath(result), "reviews.example"));
    // The output path is not in the audit record: an operator's destination is
    // not something the audit trail needs, and a path is the field of this
    // operation most likely to name a mount, a host or a share.
    const events = await harness.pool.query<{ payload: Record<string, unknown> }>(
      "select payload from events where type = 'backup.created' order by recorded_at desc limit 1",
    );
    assert.ok(!JSON.stringify(events.rows[0]?.payload).includes(workspace));
  });
});

/** The path a file-destination backup published. */
function archivePath(result: { archive: string | null }): string {
  assert.ok(result.archive !== null, "the backup was streamed rather than written to a file");
  return result.archive;
}

/** Whether any member of an archive holds a given string. */
async function contains(archive: string, needle: string): Promise<boolean> {
  let found = false;
  await readArchive(archive, () =>
    Promise.resolve({
      write: (chunk: Buffer): void => {
        if (chunk.toString("utf8").includes(needle)) found = true;
      },
      end: (): void => undefined,
    }),
  );
  return found;
}

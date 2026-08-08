#!/usr/bin/env node
//
// The owner of the `docs/TESTING.md` section 16 release condition "critical
// dependency vulnerability lacks documented mitigation".
//
// Every other condition in that list already had a suite behind it. This one
// had nothing at all, so this file is the gate rather than a wrapper around
// one. It answers a single question — does this tree carry a dependency
// vulnerability that nothing has written a mitigation for — and it answers it
// in a way that cannot report a pass when it did not look.
//
// Three properties are load-bearing.
//
//   * **It fails closed.** An advisory source that cannot be reached, answers
//     something unparseable, or answers from a database that has not been
//     updated for a month is a *failure*, not a pass. `pnpm audit` exits
//     non-zero both when it finds vulnerabilities and when the registry is
//     unreachable, so the exit code alone cannot be read; the shape of the
//     answer is what distinguishes them, and this reads the shape.
//
//   * **It states its own bounds.** It blocks on `critical` npm advisories,
//     because that is the condition section 16 names, and it prints every
//     lower-severity advisory beside them so that the narrowing is visible in
//     the run rather than implied by silence. It does not scan container base
//     images, and it says so in its own summary. A gate that quietly covers
//     less than a reader assumes is worse than one that covers nothing,
//     because the reader stops looking.
//
//   * **A mitigation has an expiry.** An entry in the register is a statement
//     that somebody looked; `review_by` is the date that statement stops being
//     current. An undated permanent exception is how a register of this kind
//     rots into a list nobody reads, and an expired entry is not a documented
//     mitigation — it is a documented one from last year.
//
// Usage:
//
//     node .github/scripts/dependency-audit.mjs [--summary FILE] [--json FILE]
//
// With no `--summary` it writes to `$GITHUB_STEP_SUMMARY` when that is set.
// The same report always goes to stdout, so a local run reads identically to a
// pipeline run.
//
// Exit codes: 0 every advisory is either below the blocking severity or has a
// current documented mitigation; 1 something blocks the release, including an
// advisory source that could not be trusted.

import { spawnSync } from "node:child_process";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const REGISTER_PATH = resolve(HERE, "..", "dependency-mitigations.json");

/**
 * The npm severity at which an advisory blocks a release.
 *
 * `docs/TESTING.md` section 16 says "critical dependency vulnerability", and
 * this gate does not quietly mean something else. Everything below it is
 * reported and does not block.
 */
const BLOCKING_NPM_SEVERITY = "critical";

/** Severities in the order the report prints them. */
const SEVERITY_ORDER = ["critical", "high", "moderate", "low", "info"];

/**
 * How stale the Go vulnerability database may be before this gate treats it as
 * unavailable.
 *
 * `govulncheck` reports `db_last_modified`, so "the source answered" and "the
 * source answered with current data" are separable here, and they are not the
 * same question. A frozen mirror answers every query successfully and reports
 * nothing new for ever, which is the failure mode a network error would at
 * least have been honest about.
 */
const GO_DATABASE_MAX_AGE_DAYS = 30;

/** The Go modules of `docs/DEVELOPMENT.md` section 5. */
const GO_MODULES = ["packages/protocol", "services/connector", "services/tunnel-gateway"];

class GateFailure extends Error {}

/** A source this gate could not trust. Always fatal; never a pass. */
class SourceUnavailable extends GateFailure {}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

const REGISTER_FIELDS = new Set([
  "advisory",
  "ecosystem",
  "package",
  "severity",
  "mitigation",
  "recorded_on",
  "review_by",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Reads and validates `.github/dependency-mitigations.json`.
 *
 * Validation is strict, and refuses an unknown member rather than ignoring it.
 * The failure this gate exists to prevent is an exemption that is present in
 * the file and absent from the decision: a typo in `advisory` would otherwise
 * produce an entry that reads as a mitigation to a human and matches nothing
 * at all here.
 */
function loadRegister(now) {
  let raw;
  try {
    raw = readFileSync(REGISTER_PATH, "utf8");
  } catch (error) {
    throw new GateFailure(
      `The mitigation register ${REGISTER_PATH} could not be read (${error.message}). ` +
        "An absent register is not an empty one: it means this gate cannot tell an " +
        "unmitigated advisory from a mitigated one.",
    );
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new GateFailure(`The mitigation register is not valid JSON: ${error.message}`);
  }

  const entries = document?.mitigations;
  if (!Array.isArray(entries)) {
    throw new GateFailure('The mitigation register must carry a "mitigations" array.');
  }

  const byAdvisory = new Map();
  const problems = [];
  for (const [index, entry] of entries.entries()) {
    const where = `mitigations[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${where} is not an object.`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!REGISTER_FIELDS.has(key)) problems.push(`${where} carries an unknown member "${key}".`);
    }
    for (const key of ["advisory", "ecosystem", "package", "mitigation", "recorded_on", "review_by"]) {
      if (typeof entry[key] !== "string" || entry[key] === "") {
        problems.push(`${where} is missing "${key}".`);
      }
    }
    if (typeof entry.mitigation === "string" && entry.mitigation.trim().length < 40) {
      // A register whose entries read "not exploitable" documents nothing. The
      // bound is arbitrary and the point is not: the field has to carry a
      // reason a reader who was not there can evaluate.
      problems.push(
        `${where} states a mitigation of ${entry.mitigation.trim().length} characters. ` +
          "A mitigation must say why this advisory does not reach this product, or what was done about it.",
      );
    }
    for (const key of ["recorded_on", "review_by"]) {
      if (typeof entry[key] === "string" && !ISO_DATE.test(entry[key])) {
        problems.push(`${where}.${key} is not an ISO date (YYYY-MM-DD).`);
      }
    }
    if (typeof entry.advisory === "string" && entry.advisory !== "") {
      if (byAdvisory.has(entry.advisory)) {
        problems.push(`${where} repeats advisory ${entry.advisory}.`);
      }
      byAdvisory.set(entry.advisory, entry);
    }
  }

  if (problems.length > 0) {
    throw new GateFailure(`The mitigation register is malformed:\n  - ${problems.join("\n  - ")}`);
  }

  const expired = [];
  for (const entry of byAdvisory.values()) {
    if (Date.parse(`${entry.review_by}T23:59:59Z`) < now.getTime()) expired.push(entry);
  }

  return { entries: byAdvisory, expired };
}

// ---------------------------------------------------------------------------
// npm advisories
// ---------------------------------------------------------------------------

/**
 * Runs `pnpm audit --json` and returns the advisories it reported.
 *
 * `pnpm audit` exits 1 both when it finds something and when it cannot reach
 * the registry, so the exit code is not the signal. What separates the two is
 * the document: a successful run carries `metadata.vulnerabilities` and an
 * `advisories` object, and a failed one carries `{"error": {...}}`. Anything
 * that is neither is treated as a failure, because an answer this gate cannot
 * interpret is an answer it must not act on.
 */
function runPnpmAudit(extraArguments) {
  // `REVIEWPLANE_AUDIT_REGISTRY` names the advisory endpoint. It exists for two
  // reasons and both are real: a self-hosting maintainer may run an internal
  // npm mirror, and pointing it at an unreachable host is the only way to
  // exercise this function's fail-closed path from the outside. `pnpm audit`
  // does not read `npm_config_registry` from the environment, so passing the
  // flag is the whole of it.
  const registry = process.env.REVIEWPLANE_AUDIT_REGISTRY;
  const result = spawnSync(
    "pnpm",
    [
      "audit",
      "--json",
      "--ignore-registry-errors=false",
      ...(registry === undefined || registry === "" ? [] : [`--registry=${registry}`]),
      ...extraArguments,
    ],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );

  if (result.error !== undefined) {
    throw new SourceUnavailable(`pnpm audit could not be run: ${result.error.message}`);
  }

  const stdout = result.stdout ?? "";
  let document;
  try {
    document = JSON.parse(stdout);
  } catch {
    throw new SourceUnavailable(
      "pnpm audit did not answer with JSON, so the npm advisory source could not be read.\n" +
        `  exit status: ${result.status}\n` +
        `  stdout (first 2000 bytes): ${stdout.slice(0, 2000)}\n` +
        `  stderr (first 2000 bytes): ${(result.stderr ?? "").slice(0, 2000)}`,
    );
  }

  if (document?.error !== undefined) {
    throw new SourceUnavailable(
      `The npm advisory source refused the query: ${JSON.stringify(document.error)}`,
    );
  }
  if (document?.metadata?.vulnerabilities === undefined || typeof document.advisories !== "object") {
    throw new SourceUnavailable(
      "pnpm audit answered a document with no advisory metadata, so nothing here can be " +
        `distinguished from a clean tree: ${stdout.slice(0, 2000)}`,
    );
  }

  const advisories = new Map();
  for (const [id, advisory] of Object.entries(document.advisories ?? {})) {
    const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []);
    advisories.set(String(advisory.github_advisory_id ?? advisory.url ?? id), {
      id: String(advisory.github_advisory_id ?? advisory.url ?? id),
      auditId: id,
      severity: String(advisory.severity ?? "unknown").toLowerCase(),
      module: String(advisory.module_name ?? "unknown"),
      title: String(advisory.title ?? "").trim(),
      vulnerable: String(advisory.vulnerable_versions ?? "").trim(),
      patched: String(advisory.patched_versions ?? "").trim(),
      paths,
    });
  }

  return { advisories, metadata: document.metadata };
}

/**
 * The npm half of the gate.
 *
 * Two queries rather than one. The whole tree answers "what is here", and
 * `--prod` answers "what ships", and labelling each advisory with which of the
 * two it came from is the difference between a register entry a reader can
 * evaluate and one they have to research. Neither query narrows what blocks:
 * a critical advisory blocks whichever set it is in, because a build-time
 * compromise is still a compromise of the thing that was built.
 */
function auditNpm() {
  const all = runPnpmAudit([]);
  const production = runPnpmAudit(["--prod"]);
  const advisories = [];
  for (const advisory of all.advisories.values()) {
    advisories.push({
      ...advisory,
      ecosystem: "npm",
      reach: production.advisories.has(advisory.id) ? "production" : "development-only",
    });
  }
  advisories.sort(
    (left, right) =>
      SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity) ||
      left.id.localeCompare(right.id),
  );
  return { advisories, metadata: all.metadata };
}

// ---------------------------------------------------------------------------
// Go advisories
// ---------------------------------------------------------------------------

/**
 * Splits govulncheck's output stream into JSON documents.
 *
 * The stream is a concatenation of pretty-printed objects rather than one
 * array or one object per line, so neither `JSON.parse` nor a line split
 * reads it. This walks the brace depth, ignoring braces inside strings.
 */
function splitJsonStream(text) {
  const documents = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        documents.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return documents;
}

/**
 * Runs `govulncheck` over one Go module.
 *
 * The Go modules here depend on the standard library and on this repository
 * alone, so what this reports is overwhelmingly the toolchain — which is a
 * dependency, is shipped inside every image, and is exactly what a release
 * gate that only looked at `package.json` would miss.
 *
 * Severity is deliberately not thresholded. The Go vulnerability database
 * carries no severity this gate could compare against `critical`, so the
 * blocking set is instead the findings govulncheck reports at **called-symbol**
 * level: a vulnerability whose vulnerable function this code can actually
 * reach. That is a stronger statement than a severity label, and the findings
 * that do not reach that level are printed rather than dropped.
 */
function auditGoModule(moduleDirectory, binary) {
  const result = spawnSync(binary, ["-format", "json", "-C", moduleDirectory, "./..."], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TMPDIR: process.env.TMPDIR ?? "/var/tmp" },
  });

  if (result.error !== undefined) {
    throw new SourceUnavailable(
      `govulncheck could not be run for ${moduleDirectory}: ${result.error.message}`,
    );
  }

  const documents = splitJsonStream(result.stdout ?? "").map((text) => JSON.parse(text));
  const config = documents.find((document) => document.config !== undefined)?.config;
  if (config === undefined) {
    throw new SourceUnavailable(
      `govulncheck answered no configuration message for ${moduleDirectory}, so the Go ` +
        "advisory database cannot be shown to have been consulted.\n" +
        `  exit status: ${result.status}\n` +
        `  stderr (first 2000 bytes): ${(result.stderr ?? "").slice(0, 2000)}`,
    );
  }

  const lastModified = Date.parse(config.db_last_modified ?? "");
  if (Number.isNaN(lastModified)) {
    throw new SourceUnavailable(
      `govulncheck reported no usable db_last_modified for ${moduleDirectory} ` +
        `(${String(config.db_last_modified)}).`,
    );
  }
  const ageDays = (Date.now() - lastModified) / 86_400_000;
  if (ageDays > GO_DATABASE_MAX_AGE_DAYS) {
    throw new SourceUnavailable(
      `The Go vulnerability database was last modified ${ageDays.toFixed(1)} days ago ` +
        `(${config.db_last_modified}), past the ${GO_DATABASE_MAX_AGE_DAYS}-day bound. A source ` +
        "that answers from frozen data reports nothing new for ever, which reads as a clean tree.",
    );
  }

  const osvById = new Map();
  for (const document of documents) {
    if (document.osv !== undefined) osvById.set(document.osv.id, document.osv);
  }

  const findings = new Map();
  for (const document of documents) {
    const finding = document.finding;
    if (finding === undefined) continue;
    const frame = (finding.trace ?? [])[0] ?? {};
    const called = typeof frame.function === "string" && frame.function !== "";
    const existing = findings.get(finding.osv);
    if (existing !== undefined && (existing.called || !called)) continue;
    findings.set(finding.osv, {
      id: finding.osv,
      ecosystem: "go",
      module: frame.module ?? finding.osv,
      severity: called ? "reachable" : "imported",
      called,
      title: (osvById.get(finding.osv)?.summary ?? "").trim(),
      fixed: finding.fixed_version ?? "",
      where: moduleDirectory,
    });
  }

  return { findings: [...findings.values()], config };
}

/** Runs govulncheck over every Go module and merges what they report. */
function auditGo(binary) {
  const merged = new Map();
  const configs = [];
  for (const moduleDirectory of GO_MODULES) {
    const { findings, config } = auditGoModule(moduleDirectory, binary);
    configs.push({ module: moduleDirectory, ...config });
    for (const finding of findings) {
      const existing = merged.get(finding.id);
      if (existing === undefined) merged.set(finding.id, { ...finding, where: [finding.where] });
      else {
        existing.where.push(finding.where);
        if (finding.called && !existing.called) {
          existing.called = true;
          existing.severity = "reachable";
        }
      }
    }
  }
  return { findings: [...merged.values()], configs };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function table(rows) {
  if (rows.length === 0) return "";
  const lines = ["| Advisory | Ecosystem | Package | Severity | Reach | Verdict |", "|---|---|---|---|---|---|"];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return `${lines.join("\n")}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const readOption = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  const summaryPath = readOption("--summary") ?? process.env.GITHUB_STEP_SUMMARY;
  const jsonPath = readOption("--json");
  const govulncheck = process.env.GOVULNCHECK ?? "govulncheck";
  const now = new Date();

  const report = [];
  const blocking = [];
  const write = (line) => report.push(line);

  write("## Dependency vulnerability gate");
  write("");
  write(
    "Owner of the `docs/TESTING.md` §16 condition *critical dependency vulnerability lacks " +
      "documented mitigation*. It fails closed: an advisory source that cannot be reached, " +
      "answers unparseably, or answers from stale data is a failure and never a pass.",
  );
  write("");

  let register;
  let npm;
  let go;
  try {
    register = loadRegister(now);
    npm = auditNpm();
    go = auditGo(govulncheck);
  } catch (error) {
    write("### Result: **blocked**");
    write("");
    write(
      error instanceof SourceUnavailable
        ? "An advisory source could not be trusted, so this gate cannot say the tree is clean."
        : "The gate could not run.",
    );
    write("");
    write("```");
    write(String(error.message));
    write("```");
    emit(report, summaryPath, jsonPath, { status: "blocked", reason: String(error.message) });
    return 1;
  }

  const rows = [];
  const counts = Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, 0]));

  for (const advisory of npm.advisories) {
    counts[advisory.severity] = (counts[advisory.severity] ?? 0) + 1;
    const entry = register.entries.get(advisory.id);
    let verdict;
    if (advisory.severity !== BLOCKING_NPM_SEVERITY) {
      verdict = "reported, below the blocking severity";
    } else if (entry === undefined) {
      verdict = "**blocks: no documented mitigation**";
      blocking.push(
        `${advisory.id} (${advisory.module}, ${advisory.severity}) has no entry in the register.`,
      );
    } else if (register.expired.includes(entry)) {
      verdict = `**blocks: mitigation expired ${entry.review_by}**`;
      blocking.push(
        `${advisory.id} (${advisory.module}, ${advisory.severity}) has a mitigation whose review ` +
          `date ${entry.review_by} has passed.`,
      );
    } else {
      verdict = `mitigated, review by ${entry.review_by}`;
    }
    rows.push([
      advisory.id,
      "npm",
      advisory.module,
      advisory.severity,
      advisory.reach,
      verdict,
    ]);
  }

  for (const finding of go.findings) {
    const entry = register.entries.get(finding.id);
    let verdict;
    if (!finding.called) {
      verdict = "reported, vulnerable symbol not reachable from this code";
    } else if (entry === undefined) {
      verdict = "**blocks: no documented mitigation**";
      blocking.push(
        `${finding.id} (${finding.module}) is reachable from ${finding.where.join(", ")} and has ` +
          "no entry in the register.",
      );
    } else if (register.expired.includes(entry)) {
      verdict = `**blocks: mitigation expired ${entry.review_by}**`;
      blocking.push(
        `${finding.id} (${finding.module}) has a mitigation whose review date ${entry.review_by} ` +
          "has passed.",
      );
    } else {
      verdict = `mitigated, review by ${entry.review_by}`;
    }
    rows.push([
      finding.id,
      "go",
      finding.module,
      finding.called ? "reachable" : "imported",
      Array.isArray(finding.where) ? finding.where.join(", ") : String(finding.where),
      verdict,
    ]);
  }

  write("### Advisories");
  write("");
  write(rows.length === 0 ? "No advisory was reported by either source." : table(rows));
  write("");

  write("### Sources");
  write("");
  write(
    `- npm: \`pnpm audit\` over ${npm.metadata.totalDependencies} resolved packages ` +
      `(${npm.metadata.dependencies} production, ${npm.metadata.devDependencies} development, ` +
      `${npm.metadata.optionalDependencies} optional). Counted by severity: ` +
      SEVERITY_ORDER.map((severity) => `${severity} ${counts[severity] ?? 0}`).join(", ") +
      ".",
  );
  for (const config of go.configs) {
    write(
      `- go: \`govulncheck ${config.scanner_version}\` over \`${config.module}\` at scan level ` +
        `\`${config.scan_level}\`, database \`${config.db}\` last modified ` +
        `${config.db_last_modified}, toolchain ${config.go_version}.`,
    );
  }
  write("");

  write("### What this gate does not cover");
  write("");
  write(
    "Stated here rather than left to be assumed. A gate whose reader believes it covers more " +
      "than it does is the failure this section exists to prevent.",
  );
  write("");
  write(
    `- **Severity narrowing.** Only \`${BLOCKING_NPM_SEVERITY}\` npm advisories block. Every ` +
      "lower severity is in the table above with the verdict *reported*, so the narrowing is " +
      "visible in the run.",
  );
  write(
    "- **Reachability narrowing.** For Go, only findings whose vulnerable symbol this code can " +
      "reach block. Imported-but-unreachable findings are in the table with that verdict.",
  );
  write(
    "- **Container base images are not scanned.** `deploy/compose/compose.yaml` pins PostgreSQL " +
      "by digest and the ReviewPlane images are built from `node:24-bookworm-slim` and the " +
      "Playwright image; nothing here reads their operating-system package manifests. " +
      "`docs/SECURITY.md` §19 records that as not implemented.",
  );
  write(
    "- **The npm advisory source reports no freshness.** The Go database does, and staleness past " +
      `${GO_DATABASE_MAX_AGE_DAYS} days fails this gate; there is no equivalent signal from the ` +
      "npm registry, so a silently frozen npm advisory feed would not be detected here.",
  );
  write("");

  const stale = [...register.entries.values()].filter(
    (entry) =>
      !npm.advisories.some((advisory) => advisory.id === entry.advisory) &&
      !go.findings.some((finding) => finding.id === entry.advisory),
  );
  if (stale.length > 0) {
    write("### Register entries matching nothing reported");
    write("");
    write(
      "These do not block — an exemption for an advisory that is no longer present hides " +
        "nothing — but they are dead weight and should be removed.",
    );
    write("");
    for (const entry of stale) write(`- ${entry.advisory} (${entry.ecosystem}, ${entry.package})`);
    write("");
  }

  const expiredUnused = register.expired.filter((entry) => stale.includes(entry));
  if (expiredUnused.length > 0) {
    write(
      `${expiredUnused.length} expired register entr${expiredUnused.length === 1 ? "y" : "ies"} ` +
        "matched no reported advisory and therefore did not block.",
    );
    write("");
  }

  if (blocking.length > 0) {
    write("### Result: **blocked**");
    write("");
    for (const reason of blocking) write(`- ${reason}`);
    write("");
    write(
      "Add an entry to `.github/dependency-mitigations.json` recording why this advisory does " +
        "not reach this product, or what was done about it, with a `review_by` date. Upgrading " +
        "the dependency is the other way through.",
    );
    emit(report, summaryPath, jsonPath, { status: "blocked", blocking, rows });
    return 1;
  }

  write("### Result: **clear**");
  write("");
  write("No critical npm advisory and no reachable Go advisory lacks a current documented mitigation.");
  emit(report, summaryPath, jsonPath, { status: "clear", rows });
  return 0;
}

function emit(report, summaryPath, jsonPath, machine) {
  const text = `${report.join("\n")}\n`;
  process.stdout.write(text);
  if (summaryPath !== undefined) {
    try {
      appendFileSync(summaryPath, text);
    } catch (error) {
      process.stderr.write(`could not write the summary to ${summaryPath}: ${error.message}\n`);
    }
  }
  if (jsonPath !== undefined) {
    try {
      writeFileSync(jsonPath, `${JSON.stringify(machine, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`could not write ${jsonPath}: ${error.message}\n`);
    }
  }
}

process.exit(main());

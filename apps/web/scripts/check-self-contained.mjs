/**
 * Fails the build when the bundle would fetch anything from another host.
 *
 * ADR-0011's unchanged requirements forbid a runtime dependency on an external
 * CDN, font or analytics service, and `AGENTS.md` forbids sending anything to
 * a third party unless an administrator configured it. A stylesheet that
 * `@import`s a font, or a script tag someone adds to `index.html`, would
 * violate both silently — the page would still work on a developer's machine
 * with internet access and fail, or leak, on an air-gapped install.
 *
 * The check is part of `pnpm build` rather than of the test suite because it
 * is a property of the artefact rather than of the source.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/**
 * Absolute URLs are allowed only when they are documentation, a namespace or
 * an intentionally unreachable example. Anything a browser would actually
 * fetch has to be local.
 */
const ALLOWED = [
  // Documentation links and XML namespaces that appear in comments and in SVG
  // markup. A browser fetches neither.
  /^https?:\/\/(www\.)?w3\.org(\/|$)/u,
  /^https?:\/\/(www\.)?json-schema\.org(\/|$)/u,
  /^https?:\/\/github\.com\/danjonesio\/reviewplane(\/|$)/u,
  /^https?:\/\/vite\.dev(\/|$)/u,
  /^https?:\/\/tanstack\.com(\/|$)/u,
  /^https?:\/\/(legacy\.)?react(js)?\.(dev|org)(\/|$)/u,
  /^https?:\/\/(www\.)?tailwindcss\.com(\/|$)/u,
  // Reserved names that resolve nowhere by definition (RFC 6761), used by the
  // product's own internal route origins.
  /^https?:\/\/[a-z0-9.-]*invalid(:\d+)?(\/|$)/u,
  // Loopback. Libraries use it as a parsing base for relative URLs; it is
  // never another party's host.
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/u,
];

const URL_PATTERN = /https?:\/\/[^\s"'`)\\<>]+/gu;
const FETCHING_MARKUP =
  /<(script|link|img|iframe|source|video|audio|object|embed)\b[^>]*\b(src|href)\s*=\s*["']https?:/giu;

function* files(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      yield* files(path);
      continue;
    }
    yield path;
  }
}

const problems = [];

for (const path of files(distDirectory)) {
  const extension = extname(path);
  // Source maps carry the sources' own comments; the shipped page is what
  // matters, and a map is never fetched by the page itself.
  if (extension === ".map") continue;
  if (![".html", ".js", ".css"].includes(extension)) continue;
  const contents = readFileSync(path, "utf8");

  for (const match of contents.matchAll(URL_PATTERN)) {
    const url = match[0];
    if (ALLOWED.some((allowed) => allowed.test(url))) continue;
    problems.push(`${path}: absolute URL ${url}`);
  }
  for (const match of contents.matchAll(FETCHING_MARKUP)) {
    problems.push(`${path}: markup that loads from another host: ${match[0].slice(0, 120)}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(
    `the built bundle would reach an external host, which ADR-0011 forbids:\n  ${problems.join("\n  ")}\n`,
  );
  process.exit(1);
}

process.stdout.write("bundle is self-contained: no external host is referenced\n");

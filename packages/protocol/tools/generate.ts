/**
 * Generates the TypeScript and Go models from the single schema source.
 *
 * Run with `pnpm protocol:generate`. `pnpm protocol:check` renders the same
 * output in memory and fails when it differs from the committed files, so a
 * change to one language cannot land without the other.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  emitGoDecode,
  emitGoDispatch,
  emitGoEncode,
  emitGoTypes,
  emitGoValidate,
  goPackageName,
} from "./emit-go.ts";
import {
  emitDecode,
  emitDispatch,
  emitEncode,
  emitIndex,
  emitTypes,
  emitValidate,
} from "./emit-typescript.ts";
import { loadProtocolModel, type ProtocolModel } from "./schema-model.ts";

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every schema source in the package. One entry per protocol version; the
 * languages a source renders are declared in its own `x-protocol.languages`,
 * so an omission is a property of the schema rather than of this list.
 */
export const SCHEMA_SOURCES: readonly string[] = [
  join(packageRoot, "schemas", "connector", "v1.schema.json"),
  join(packageRoot, "schemas", "browser", "v1.schema.json"),
  join(packageRoot, "schemas", "live_view", "v1.schema.json"),
];

/** Retained for callers that only need the connector source. */
export const schemaPath = SCHEMA_SOURCES[0] as string;

export class GofmtUnavailableError extends Error {}

function gofmt(source: string): string {
  try {
    return execFileSync("gofmt", [], { input: source, encoding: "utf8" });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new GofmtUnavailableError(
      `gofmt failed. The Go toolchain is required to generate or check the protocol package (docs/DEVELOPMENT.md section 2). ${details}`,
    );
  }
}

function normaliseTypeScript(source: string): string {
  const collapsed = source.replace(/\n{3,}/gu, "\n\n").trimEnd();
  return `${collapsed}\n`;
}

/**
 * TypeScript output directory for a source, mirroring the schema path so a
 * generated file and its source are found from one another.
 */
function typeScriptOutputDir(model: ProtocolModel): string {
  return join("src", "generated", model.name, `v${String(model.version)}`);
}

/** Renders every generated file for one source, keyed by package-relative path. */
export function renderAll(model: ProtocolModel): Map<string, string> {
  const files = new Map<string, string>();

  if (model.languages.includes("typescript")) {
    const directory = typeScriptOutputDir(model);
    files.set(join(directory, "types.ts"), normaliseTypeScript(emitTypes(model)));
    files.set(join(directory, "validate.ts"), normaliseTypeScript(emitValidate(model)));
    files.set(join(directory, "decode.ts"), normaliseTypeScript(emitDecode(model)));
    files.set(join(directory, "encode.ts"), normaliseTypeScript(emitEncode(model)));
    files.set(join(directory, "dispatch.ts"), normaliseTypeScript(emitDispatch(model)));
    files.set(join(directory, "index.ts"), normaliseTypeScript(emitIndex(model)));
  }

  if (model.languages.includes("go")) {
    const directory = goPackageName(model);
    files.set(join(directory, "types_gen.go"), gofmt(emitGoTypes(model)));
    files.set(join(directory, "validate_gen.go"), gofmt(emitGoValidate(model)));
    files.set(join(directory, "decode_gen.go"), gofmt(emitGoDecode(model)));
    files.set(join(directory, "encode_gen.go"), gofmt(emitGoEncode(model)));
    files.set(join(directory, "dispatch_gen.go"), gofmt(emitGoDispatch(model)));
  }

  return files;
}

/** Renders every source in the package, keyed by package-relative path. */
export function renderEverySource(): Map<string, string> {
  const files = new Map<string, string>();
  for (const source of SCHEMA_SOURCES) {
    for (const [relativePath, contents] of renderAll(loadProtocolModel(source))) {
      if (files.has(relativePath)) {
        throw new Error(`two schema sources both render ${relativePath}`);
      }
      files.set(relativePath, contents);
    }
  }
  return files;
}

function main(): void {
  const files = renderEverySource();
  for (const [relativePath, contents] of files) {
    const absolutePath = join(packageRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf8");
    process.stdout.write(`wrote ${relativePath}\n`);
  }
  process.stdout.write(
    `generated ${String(files.size)} files from ${String(SCHEMA_SOURCES.length)} schema sources\n`,
  );
}

if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

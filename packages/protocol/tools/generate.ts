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
export const schemaPath = join(packageRoot, "schemas", "connector", "v1.schema.json");

const TS_OUTPUT_DIR = join("src", "generated", "connector", "v1");
const GO_OUTPUT_DIR = "connectorv1";

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

/** Renders every generated file. Keys are paths relative to the package root. */
export function renderAll(model: ProtocolModel): Map<string, string> {
  const files = new Map<string, string>();

  files.set(join(TS_OUTPUT_DIR, "types.ts"), normaliseTypeScript(emitTypes(model)));
  files.set(join(TS_OUTPUT_DIR, "validate.ts"), normaliseTypeScript(emitValidate(model)));
  files.set(join(TS_OUTPUT_DIR, "decode.ts"), normaliseTypeScript(emitDecode(model)));
  files.set(join(TS_OUTPUT_DIR, "encode.ts"), normaliseTypeScript(emitEncode(model)));
  files.set(join(TS_OUTPUT_DIR, "dispatch.ts"), normaliseTypeScript(emitDispatch(model)));
  files.set(join(TS_OUTPUT_DIR, "index.ts"), normaliseTypeScript(emitIndex(model)));

  files.set(join(GO_OUTPUT_DIR, "types_gen.go"), gofmt(emitGoTypes(model)));
  files.set(join(GO_OUTPUT_DIR, "validate_gen.go"), gofmt(emitGoValidate(model)));
  files.set(join(GO_OUTPUT_DIR, "decode_gen.go"), gofmt(emitGoDecode(model)));
  files.set(join(GO_OUTPUT_DIR, "encode_gen.go"), gofmt(emitGoEncode(model)));
  files.set(join(GO_OUTPUT_DIR, "dispatch_gen.go"), gofmt(emitGoDispatch(model)));

  return files;
}

function main(): void {
  const model = loadProtocolModel(schemaPath);
  const files = renderAll(model);
  for (const [relativePath, contents] of files) {
    const absolutePath = join(packageRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents, "utf8");
    process.stdout.write(`wrote ${relativePath}\n`);
  }
  process.stdout.write(`generated ${files.size} files from ${model.title}\n`);
}

if (process.argv[1] !== undefined && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

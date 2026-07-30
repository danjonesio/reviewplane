/**
 * Loader and subset validator for the protocol schema source.
 *
 * The generator accepts a deliberately small JSON Schema subset. Any keyword it
 * does not understand is an error rather than a silent omission, because a
 * dropped constraint would weaken a bound that docs/CONNECTOR_PROTOCOL.md
 * section 22 and docs/DEVELOPMENT.md section 10 require the parser to enforce.
 */

import { readFileSync } from "node:fs";

/**
 * Byte bounds declared by `x-protocol.limits`, in declaration order. Each
 * protocol names its own limits; `x-protocol.envelope_limit` says which one
 * bounds an envelope frame.
 */
export type ProtocolLimits = ReadonlyMap<string, number>;

/** Languages the generator renders for a schema source. */
export type TargetLanguage = "typescript" | "go";

export interface MessageSpec {
  readonly type: string;
  readonly channel: string;
  readonly direction: string;
  readonly payloadDef: string;
  readonly description: string;
}

export interface StandaloneSpec {
  readonly name: string;
  readonly channel: string;
  readonly def: string;
  readonly maxBytesLimit: string;
  readonly description: string;
}

/** A documented list of values a protocol names but does not validate against. */
export interface VocabularySpec {
  readonly description: string;
  readonly values: readonly string[];
}

export interface ViolationReasonSpec {
  readonly name: string;
  readonly errorClass: string | null;
  readonly description: string;
}

export interface RequireRule {
  readonly whenProperty: string;
  readonly whenValues: readonly string[];
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
  readonly detail: string;
}

export interface PropertySpec {
  readonly name: string;
  readonly description: string;
  readonly node: Node;
  /** Name of the `$defs` entry this property refers to, when it is a `$ref`. */
  readonly ref: string | null;
  readonly optional: boolean;
}

export interface StringNode {
  readonly kind: "string";
  readonly description: string;
  readonly minLength: number | null;
  readonly maxLength: number;
  readonly pattern: string | null;
  readonly enumValues: readonly string[] | null;
  readonly sensitive: boolean;
  /** Generated enumeration type name, set for every node carrying `enum`. */
  readonly enumTypeName: string | null;
}

export interface IntegerNode {
  readonly kind: "integer";
  readonly description: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly constValue: number | null;
}

export interface NumberNode {
  readonly kind: "number";
  readonly description: string;
  readonly minimum: number;
  readonly maximum: number;
}

export interface BooleanNode {
  readonly kind: "boolean";
  readonly description: string;
}

export interface ArrayNode {
  readonly kind: "array";
  readonly description: string;
  readonly item: Node;
  readonly itemRef: string | null;
  readonly minItems: number;
  readonly maxItems: number;
  readonly uniqueItems: boolean;
}

export interface ObjectNode {
  readonly kind: "object";
  readonly description: string;
  readonly typeName: string;
  readonly properties: readonly PropertySpec[];
  readonly required: readonly string[];
  readonly requires: readonly RequireRule[];
  readonly maxBytes: number | null;
}

export interface DynamicNode {
  readonly kind: "dynamic";
  readonly description: string;
}

export type Node =
  | StringNode
  | IntegerNode
  | NumberNode
  | BooleanNode
  | ArrayNode
  | ObjectNode
  | DynamicNode;

export interface EnumType {
  readonly typeName: string;
  readonly values: readonly string[];
  readonly description: string;
}

export interface ProtocolModel {
  readonly sourcePath: string;
  /** Package-relative path, as it appears in the generated-file banner. */
  readonly sourceRelative: string;
  readonly sourceText: string;
  readonly name: string;
  readonly version: number;
  readonly title: string;
  /** Languages rendered from this source. Declared, so an omission is visible. */
  readonly languages: readonly TargetLanguage[];
  readonly limits: ProtocolLimits;
  /** Key of `limits` that bounds an envelope frame of this protocol. */
  readonly envelopeLimit: string;
  /**
   * Envelope property holding the type-selected payload. It defaults to
   * `payload`, which is what a wire protocol calls it; a source whose envelope
   * is specified elsewhere under another name declares that name here rather
   * than renaming the field and leaving the schema and the document disagreeing
   * about what goes on the wire.
   */
  readonly envelopePayloadProperty: string;
  readonly channels: ReadonlyMap<string, string>;
  /** Sender roles a message may declare, in declaration order. */
  readonly directions: readonly string[];
  readonly messages: readonly MessageSpec[];
  readonly standalone: readonly StandaloneSpec[];
  readonly errorClasses: readonly string[];
  readonly violationReasons: readonly ViolationReasonSpec[];
  readonly schemaViolationCodes: readonly string[];
  /**
   * Named lists of values a protocol documents but does not validate against,
   * such as the connector's known capabilities. Emitted in declaration order.
   */
  readonly vocabularies: ReadonlyMap<string, VocabularySpec>;
  readonly identifierPrefixes: ReadonlyMap<string, string>;
  readonly defs: ReadonlyMap<string, Node>;
  /** `$defs` order, preserved so generated output is deterministic. */
  readonly defOrder: readonly string[];
  readonly enums: readonly EnumType[];
}

export class SchemaError extends Error {}

const NODE_KEYS = new Set([
  "description",
  "type",
  "$ref",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
  "x-sensitive",
  "x-dynamic",
  "x-max-bytes",
  "x-requires",
]);

const DOCUMENT_KEYS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "x-protocol",
  "$defs",
]);

const PROTOCOL_KEYS = new Set([
  "name",
  "version",
  "languages",
  "limits",
  "envelope_limit",
  "envelope_payload_property",
  "channels",
  "directions",
  "messages",
  "standalone",
  "error_classes",
  "violation_reasons",
  "schema_violation_codes",
  "vocabularies",
  "identifier_prefixes",
]);

const TARGET_LANGUAGES: ReadonlySet<string> = new Set(["typescript", "go"]);

/** Default sender roles, kept for a schema that does not declare its own. */
const DEFAULT_DIRECTIONS = ["connector_to_control_plane", "control_plane_to_connector"];

type Json = Record<string, unknown>;

function fail(where: string, message: string): never {
  throw new SchemaError(`${where}: ${message}`);
}

function asObject(value: unknown, where: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "expected an object");
  }
  return value as Json;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") fail(where, "expected a string");
  return value;
}

function asInteger(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(where, "expected an integer");
  }
  return value;
}

function asStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(where, "expected an array");
  return value.map((entry, index) => asString(entry, `${where}[${index}]`));
}

export function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function checkKeys(node: Json, where: string, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) {
      fail(where, `unsupported keyword "${key}"; the generator refuses keywords it cannot enforce`);
    }
  }
}

interface ParseContext {
  readonly defNames: ReadonlySet<string>;
  readonly enums: EnumType[];
}

function parseNode(
  raw: unknown,
  where: string,
  typeNameHint: string,
  context: ParseContext,
): { node: Node; ref: string | null } {
  const node = asObject(raw, where);
  checkKeys(node, where, NODE_KEYS);

  const description = node["description"] === undefined ? "" : asString(node["description"], `${where}.description`);

  if (node["$ref"] !== undefined) {
    const ref = asString(node["$ref"], `${where}.$ref`);
    const prefix = "#/$defs/";
    if (!ref.startsWith(prefix)) {
      fail(where, `only local "#/$defs/" references are supported, got "${ref}"`);
    }
    const refName = ref.slice(prefix.length);
    if (!context.defNames.has(refName)) fail(where, `unknown reference "${ref}"`);
    for (const key of Object.keys(node)) {
      if (key !== "$ref" && key !== "description") {
        fail(where, `"$ref" may only be accompanied by "description", found "${key}"`);
      }
    }
    // The referenced node is resolved by the caller through the def table; the
    // placeholder below is replaced during the second pass.
    return { node: { kind: "dynamic", description }, ref: refName };
  }

  if (node["x-dynamic"] === true) {
    if (node["type"] !== "object") fail(where, "x-dynamic requires type object");
    return { node: { kind: "dynamic", description }, ref: null };
  }

  const type = asString(node["type"], `${where}.type`);

  switch (type) {
    case "string": {
      const enumValues =
        node["enum"] === undefined ? null : asStringArray(node["enum"], `${where}.enum`);
      const constValue =
        node["const"] === undefined ? null : asString(node["const"], `${where}.const`);
      if (constValue !== null) {
        fail(where, "string const is not supported; use a single-valued enum");
      }
      const sensitive = node["x-sensitive"] === true;
      let maxLength: number;
      if (enumValues !== null) {
        if (enumValues.length === 0) fail(where, "enum must not be empty");
        maxLength = Math.max(...enumValues.map((value) => value.length));
      } else {
        if (node["maxLength"] === undefined) {
          fail(where, "every string needs an explicit maxLength bound");
        }
        maxLength = asInteger(node["maxLength"], `${where}.maxLength`);
        if (node["pattern"] === undefined) {
          fail(where, "every non-enumerated string needs an explicit pattern bound");
        }
      }
      const pattern =
        node["pattern"] === undefined ? null : asString(node["pattern"], `${where}.pattern`);
      if (pattern !== null) {
        try {
          new RegExp(pattern, "u");
        } catch (error) {
          fail(where, `pattern is not a valid regular expression: ${String(error)}`);
        }
      }
      const minLength =
        node["minLength"] === undefined ? null : asInteger(node["minLength"], `${where}.minLength`);
      let enumTypeName: string | null = null;
      if (enumValues !== null) {
        enumTypeName = typeNameHint;
        context.enums.push({ typeName: enumTypeName, values: enumValues, description });
      }
      return {
        node: {
          kind: "string",
          description,
          minLength,
          maxLength,
          pattern,
          enumValues,
          sensitive,
          enumTypeName,
        },
        ref: null,
      };
    }
    case "integer":
    case "number": {
      const constValue =
        node["const"] === undefined ? null : asInteger(node["const"], `${where}.const`);
      const minimum =
        node["minimum"] === undefined
          ? constValue
          : asInteger(node["minimum"], `${where}.minimum`);
      const maximum =
        node["maximum"] === undefined
          ? constValue
          : asInteger(node["maximum"], `${where}.maximum`);
      if (minimum === null || maximum === null) {
        fail(where, "every numeric field needs explicit minimum and maximum bounds");
      }
      if (type === "integer") {
        return {
          node: { kind: "integer", description, minimum, maximum, constValue },
          ref: null,
        };
      }
      if (constValue !== null) fail(where, "number const is not supported");
      return { node: { kind: "number", description, minimum, maximum }, ref: null };
    }
    case "boolean":
      return { node: { kind: "boolean", description }, ref: null };
    case "array": {
      if (node["items"] === undefined) fail(where, "array needs items");
      if (node["maxItems"] === undefined) fail(where, "every array needs an explicit maxItems bound");
      if (node["minItems"] === undefined) fail(where, "every array needs an explicit minItems bound");
      const parsedItem = parseNode(node["items"], `${where}.items`, `${typeNameHint}Item`, context);
      return {
        node: {
          kind: "array",
          description,
          item: parsedItem.node,
          itemRef: parsedItem.ref,
          minItems: asInteger(node["minItems"], `${where}.minItems`),
          maxItems: asInteger(node["maxItems"], `${where}.maxItems`),
          uniqueItems: node["uniqueItems"] === true,
        },
        ref: null,
      };
    }
    case "object": {
      if (node["additionalProperties"] !== false) {
        fail(where, "every object needs additionalProperties: false so unknown fields are rejected");
      }
      if (node["properties"] === undefined) fail(where, "object needs properties");
      if (node["required"] === undefined) fail(where, "object needs an explicit required list");
      const requiredNames = asStringArray(node["required"], `${where}.required`);
      const properties = asObject(node["properties"], `${where}.properties`);
      const propertySpecs: PropertySpec[] = [];
      for (const [propertyName, rawProperty] of Object.entries(properties)) {
        const parsed = parseNode(
          rawProperty,
          `${where}.properties.${propertyName}`,
          `${typeNameHint}${pascalCase(propertyName)}`,
          context,
        );
        propertySpecs.push({
          name: propertyName,
          description:
            parsed.node.description === ""
              ? ""
              : parsed.node.description,
          node: parsed.node,
          ref: parsed.ref,
          optional: !requiredNames.includes(propertyName),
        });
      }
      for (const requiredName of requiredNames) {
        if (!propertySpecs.some((property) => property.name === requiredName)) {
          fail(where, `required property "${requiredName}" is not declared`);
        }
      }
      const requires: RequireRule[] = [];
      if (node["x-requires"] !== undefined) {
        const rules = node["x-requires"];
        if (!Array.isArray(rules)) fail(`${where}.x-requires`, "expected an array");
        rules.forEach((rawRule, index) => {
          const ruleWhere = `${where}.x-requires[${index}]`;
          const rule = asObject(rawRule, ruleWhere);
          checkKeys(rule, ruleWhere, new Set(["when", "required", "forbidden", "detail"]));
          const when = asObject(rule["when"], `${ruleWhere}.when`);
          checkKeys(when, `${ruleWhere}.when`, new Set(["property", "equals", "in"]));
          const whenProperty = asString(when["property"], `${ruleWhere}.when.property`);
          if (!propertySpecs.some((property) => property.name === whenProperty)) {
            fail(ruleWhere, `condition references undeclared property "${whenProperty}"`);
          }
          const whenValues =
            when["in"] !== undefined
              ? asStringArray(when["in"], `${ruleWhere}.when.in`)
              : [asString(when["equals"], `${ruleWhere}.when.equals`)];
          const required =
            rule["required"] === undefined
              ? []
              : asStringArray(rule["required"], `${ruleWhere}.required`);
          const forbidden =
            rule["forbidden"] === undefined
              ? []
              : asStringArray(rule["forbidden"], `${ruleWhere}.forbidden`);
          if (required.length === 0 && forbidden.length === 0) {
            fail(ruleWhere, "a conditional rule must require or forbid at least one property");
          }
          for (const name of [...required, ...forbidden]) {
            if (!propertySpecs.some((property) => property.name === name)) {
              fail(ruleWhere, `rule references undeclared property "${name}"`);
            }
          }
          requires.push({
            whenProperty,
            whenValues,
            required,
            forbidden,
            detail: rule["detail"] === undefined ? "" : asString(rule["detail"], `${ruleWhere}.detail`),
          });
        });
      }
      const maxBytes =
        node["x-max-bytes"] === undefined
          ? null
          : asInteger(node["x-max-bytes"], `${where}.x-max-bytes`);
      return {
        node: {
          kind: "object",
          description,
          typeName: typeNameHint,
          properties: propertySpecs,
          required: requiredNames,
          requires,
          maxBytes,
        },
        ref: null,
      };
    }
    default:
      return fail(where, `unsupported type "${type}"`);
  }
}

/**
 * `JSON.parse` keeps the last of two identically named keys and reports
 * nothing, so a definition written twice silently replaces the first — and a
 * `$ref` pointing at the replaced one then resolves to something of a
 * different kind. Since the schema is the single source of truth, a duplicate
 * key anywhere in it is an error rather than something a fixture discovers
 * later.
 *
 * The scan walks the raw text because the duplicate no longer exists in the
 * parsed document. It is formatting-independent: a string token is a key when
 * the innermost open container is an object and the token is followed by a
 * colon.
 */
function assertNoDuplicateKeys(sourceText: string): void {
  const containers: { isObject: boolean; keys: Set<string> }[] = [];
  let index = 0;

  const readString = (): string => {
    // Positioned on the opening quote.
    let value = "";
    index += 1;
    while (index < sourceText.length) {
      const character = sourceText[index] as string;
      if (character === "\\") {
        value += sourceText.slice(index, index + 2);
        index += 2;
        continue;
      }
      if (character === '"') {
        index += 1;
        return value;
      }
      value += character;
      index += 1;
    }
    return value;
  };

  while (index < sourceText.length) {
    const character = sourceText[index] as string;
    if (character === '"') {
      const token = readString();
      let lookahead = index;
      while (lookahead < sourceText.length && /\s/u.test(sourceText[lookahead] as string)) {
        lookahead += 1;
      }
      const container = containers[containers.length - 1];
      if (container !== undefined && container.isObject && sourceText[lookahead] === ":") {
        if (container.keys.has(token)) {
          fail(`"${token}"`, "the same key is declared twice in one object");
        }
        container.keys.add(token);
      }
      continue;
    }
    if (character === "{") containers.push({ isObject: true, keys: new Set() });
    else if (character === "[") containers.push({ isObject: false, keys: new Set() });
    else if (character === "}" || character === "]") containers.pop();
    index += 1;
  }
}

/**
 * Renders the package-relative path used in the generated-file banner, so a
 * reader of a generated file can find the one source it came from.
 */
function packageRelativePath(sourcePath: string): string {
  const marker = `${"/"}schemas${"/"}`;
  const index = sourcePath.lastIndexOf(marker);
  if (index === -1) return sourcePath;
  return `schemas/${sourcePath.slice(index + marker.length)}`;
}

export function loadProtocolModel(sourcePath: string): ProtocolModel {
  const sourceText = readFileSync(sourcePath, "utf8");
  assertNoDuplicateKeys(sourceText);
  const document = asObject(JSON.parse(sourceText), "document");
  checkKeys(document, "document", DOCUMENT_KEYS);

  const protocol = asObject(document["x-protocol"], "x-protocol");
  checkKeys(protocol, "x-protocol", PROTOCOL_KEYS);
  const defsRaw = asObject(document["$defs"], "$defs");
  const defNames = new Set(Object.keys(defsRaw));

  const enums: EnumType[] = [];
  const context: ParseContext = { defNames, enums };

  const defs = new Map<string, Node>();
  const defOrder: string[] = [];
  for (const [defName, rawDef] of Object.entries(defsRaw)) {
    const parsed = parseNode(rawDef, `$defs.${defName}`, pascalCase(defName), context);
    if (parsed.ref !== null) fail(`$defs.${defName}`, "a top-level definition must not be a bare $ref");
    defs.set(defName, parsed.node);
    defOrder.push(defName);
  }

  // Declared rather than inferred: a source that renders only one language is
  // a deliberate scoping decision, and the reader of the schema must see it.
  const languages: TargetLanguage[] = asStringArray(
    protocol["languages"],
    "x-protocol.languages",
  ).map((language) => {
    if (!TARGET_LANGUAGES.has(language)) {
      fail("x-protocol.languages", `unknown target language "${language}"`);
    }
    return language as TargetLanguage;
  });
  if (languages.length === 0) fail("x-protocol.languages", "at least one language is required");

  const limitsRaw = asObject(protocol["limits"], "x-protocol.limits");
  const limits = new Map<string, number>();
  for (const [limitName, rawLimit] of Object.entries(limitsRaw)) {
    limits.set(limitName, asInteger(rawLimit, `x-protocol.limits.${limitName}`));
  }
  if (limits.size === 0) fail("x-protocol.limits", "at least one byte bound is required");

  const envelopeLimit =
    protocol["envelope_limit"] === undefined
      ? "max_control_frame_bytes"
      : asString(protocol["envelope_limit"], "x-protocol.envelope_limit");
  if (!limits.has(envelopeLimit)) {
    fail("x-protocol.envelope_limit", `"${envelopeLimit}" is not declared in x-protocol.limits`);
  }
  const envelopeBound = limits.get(envelopeLimit) as number;

  const envelopePayloadProperty =
    protocol["envelope_payload_property"] === undefined
      ? "payload"
      : asString(protocol["envelope_payload_property"], "x-protocol.envelope_payload_property");

  const directions =
    protocol["directions"] === undefined
      ? DEFAULT_DIRECTIONS
      : asStringArray(protocol["directions"], "x-protocol.directions");
  if (directions.length === 0) fail("x-protocol.directions", "at least one direction is required");

  const channelsRaw = asObject(protocol["channels"], "x-protocol.channels");
  const channels = new Map<string, string>();
  for (const [channel, channelDescription] of Object.entries(channelsRaw)) {
    channels.set(channel, asString(channelDescription, `x-protocol.channels.${channel}`));
  }

  const messagesRaw = asObject(protocol["messages"], "x-protocol.messages");
  const messages: MessageSpec[] = [];
  for (const [messageType, rawSpec] of Object.entries(messagesRaw)) {
    const where = `x-protocol.messages["${messageType}"]`;
    const spec = asObject(rawSpec, where);
    checkKeys(spec, where, new Set(["channel", "direction", "payload", "description"]));
    const channel = asString(spec["channel"], `${where}.channel`);
    if (!channels.has(channel)) fail(where, `unknown channel "${channel}"`);
    const direction = asString(spec["direction"], `${where}.direction`);
    if (!directions.includes(direction)) fail(where, `unknown direction "${direction}"`);
    const payloadDef = asString(spec["payload"], `${where}.payload`);
    const payloadNode = defs.get(payloadDef);
    if (payloadNode === undefined) fail(where, `unknown payload definition "${payloadDef}"`);
    if (payloadNode.kind !== "object") fail(where, "payload definition must be an object");
    if (payloadNode.maxBytes === null) {
      fail(where, "every message payload needs an explicit x-max-bytes bound");
    }
    if (payloadNode.maxBytes > envelopeBound) {
      fail(where, "payload bound exceeds the control-frame bound");
    }
    messages.push({
      type: messageType,
      channel,
      direction,
      payloadDef,
      description: asString(spec["description"], `${where}.description`),
    });
  }

  const standaloneRaw =
    protocol["standalone"] === undefined
      ? {}
      : asObject(protocol["standalone"], "x-protocol.standalone");
  const standalone: StandaloneSpec[] = [];
  for (const [name, rawSpec] of Object.entries(standaloneRaw)) {
    const where = `x-protocol.standalone.${name}`;
    const spec = asObject(rawSpec, where);
    checkKeys(spec, where, new Set(["channel", "def", "max_bytes_limit", "description"]));
    const channel = asString(spec["channel"], `${where}.channel`);
    if (!channels.has(channel)) fail(where, `unknown channel "${channel}"`);
    const defName = asString(spec["def"], `${where}.def`);
    const defNode = defs.get(defName);
    if (defNode === undefined) fail(where, `unknown definition "${defName}"`);
    if (defNode.kind !== "object") fail(where, "definition must be an object");
    if (defNode.maxBytes === null) fail(where, "standalone message needs an explicit x-max-bytes bound");
    const maxBytesLimit = asString(spec["max_bytes_limit"], `${where}.max_bytes_limit`);
    const transportBound = limits.get(maxBytesLimit);
    if (transportBound === undefined) fail(where, `unknown limit "${maxBytesLimit}"`);
    if (defNode.maxBytes > transportBound) {
      fail(where, "definition bound exceeds its transport bound");
    }
    standalone.push({
      name,
      channel,
      def: defName,
      maxBytesLimit,
      description: asString(spec["description"], `${where}.description`),
    });
  }

  const errorClasses = asStringArray(protocol["error_classes"], "x-protocol.error_classes");

  const violationReasonsRaw = asObject(protocol["violation_reasons"], "x-protocol.violation_reasons");
  const violationReasons: ViolationReasonSpec[] = [];
  for (const [name, rawSpec] of Object.entries(violationReasonsRaw)) {
    const where = `x-protocol.violation_reasons.${name}`;
    const spec = asObject(rawSpec, where);
    checkKeys(spec, where, new Set(["error_class", "description"]));
    const errorClass = spec["error_class"] === null ? null : asString(spec["error_class"], `${where}.error_class`);
    if (errorClass !== null && !errorClasses.includes(errorClass)) {
      fail(where, `unknown error class "${errorClass}"`);
    }
    violationReasons.push({
      name,
      errorClass,
      description: asString(spec["description"], `${where}.description`),
    });
  }

  const vocabulariesRaw =
    protocol["vocabularies"] === undefined
      ? {}
      : asObject(protocol["vocabularies"], "x-protocol.vocabularies");
  const vocabularies = new Map<string, VocabularySpec>();
  for (const [vocabularyName, rawVocabulary] of Object.entries(vocabulariesRaw)) {
    const where = `x-protocol.vocabularies.${vocabularyName}`;
    const spec = asObject(rawVocabulary, where);
    checkKeys(spec, where, new Set(["description", "values"]));
    vocabularies.set(vocabularyName, {
      description:
        spec["description"] === undefined ? "" : asString(spec["description"], `${where}.description`),
      values: asStringArray(spec["values"], `${where}.values`),
    });
  }

  const identifierPrefixesRaw =
    protocol["identifier_prefixes"] === undefined
      ? {}
      : asObject(protocol["identifier_prefixes"], "x-protocol.identifier_prefixes");
  const identifierPrefixes = new Map<string, string>();
  for (const [field, prefix] of Object.entries(identifierPrefixesRaw)) {
    identifierPrefixes.set(field, asString(prefix, `x-protocol.identifier_prefixes.${field}`));
  }

  const model: ProtocolModel = {
    sourcePath,
    sourceRelative: packageRelativePath(sourcePath),
    sourceText,
    name: asString(protocol["name"], "x-protocol.name"),
    version: asInteger(protocol["version"], "x-protocol.version"),
    title: asString(document["title"], "title"),
    languages,
    limits,
    envelopeLimit,
    envelopePayloadProperty,
    channels,
    directions,
    messages,
    standalone,
    errorClasses,
    violationReasons,
    schemaViolationCodes: asStringArray(
      protocol["schema_violation_codes"],
      "x-protocol.schema_violation_codes",
    ),
    vocabularies,
    identifierPrefixes,
    defs,
    defOrder,
    enums,
  };

  assertConsistency(model);
  return model;
}

/**
 * Checks the invariants that hold the document together: the enumerations
 * declared in `x-protocol` must equal the enumerations the schema validates
 * against, so a message type cannot be added in one place only.
 */
function assertConsistency(model: ProtocolModel): void {
  const messageTypeDef = model.defs.get("message_type");
  if (messageTypeDef === undefined || messageTypeDef.kind !== "string" || messageTypeDef.enumValues === null) {
    fail("$defs.message_type", "must be a string enumeration");
  }
  const declaredTypes = model.messages.map((message) => message.type);
  if (JSON.stringify(messageTypeDef.enumValues) !== JSON.stringify(declaredTypes)) {
    fail(
      "$defs.message_type",
      `enumeration ${JSON.stringify(messageTypeDef.enumValues)} does not equal x-protocol.messages keys ${JSON.stringify(declaredTypes)}`,
    );
  }

  const errorClassDef = model.defs.get("error_class");
  if (errorClassDef === undefined || errorClassDef.kind !== "string" || errorClassDef.enumValues === null) {
    fail("$defs.error_class", "must be a string enumeration");
  }
  if (JSON.stringify(errorClassDef.enumValues) !== JSON.stringify(model.errorClasses)) {
    fail("$defs.error_class", "enumeration does not equal x-protocol.error_classes");
  }

  const envelope = model.defs.get("envelope");
  if (envelope === undefined || envelope.kind !== "object") fail("$defs.envelope", "must be an object");
  const slot = model.envelopePayloadProperty;
  const payloadProperty = envelope.properties.find((property) => property.name === slot);
  if (payloadProperty === undefined || payloadProperty.node.kind !== "dynamic") {
    fail(`$defs.envelope.properties.${slot}`, "must be the dynamic payload slot");
  }

  for (const defName of model.defOrder) {
    const node = model.defs.get(defName);
    if (node === undefined) continue;
    assertNoPrivateKeyField(defName, node);
  }
}

/**
 * docs/SECURITY.md section 6.2 and docs/CONNECTOR_PROTOCOL.md section 4.2
 * require the connector private key never to leave the development
 * environment. The schema must therefore have no field capable of carrying it.
 */
function assertNoPrivateKeyField(defName: string, node: Node): void {
  if (node.kind !== "object") return;
  for (const property of node.properties) {
    if (/private|secret_key|passphrase|password/iu.test(property.name)) {
      fail(
        `$defs.${defName}.properties.${property.name}`,
        "the protocol must not declare a field capable of carrying a private key or password",
      );
    }
  }
}

export function resolve(model: ProtocolModel, property: PropertySpec): Node {
  if (property.ref === null) return property.node;
  const target = model.defs.get(property.ref);
  if (target === undefined) throw new SchemaError(`unresolved reference ${property.ref}`);
  return target;
}

export function resolveRef(model: ProtocolModel, refName: string): Node {
  const target = model.defs.get(refName);
  if (target === undefined) throw new SchemaError(`unresolved reference ${refName}`);
  return target;
}

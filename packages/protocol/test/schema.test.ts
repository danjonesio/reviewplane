/**
 * Unit layer (`docs/TESTING.md` section 2): the schema source itself is checked
 * against the normative document, and the generator is checked against the
 * rules it exists to enforce.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHANNELS,
  ERROR_CLASS_VALUES,
  IDENTIFIER_PREFIXES,
  LIMITS,
  MESSAGE_TYPE_VALUES,
  PAYLOAD_MAX_BYTES,
  PROTOCOL_VERSION,
} from "../src/generated/connector/v1/types.ts";
import { schemaPath } from "../tools/generate.ts";
import { loadProtocolModel, SchemaError, type Node } from "../tools/schema-model.ts";

const model = loadProtocolModel(schemaPath);

test("the channel enumeration matches docs/CONNECTOR_PROTOCOL.md section 6", () => {
  assert.deepEqual([...CHANNELS], [
    "control",
    "heartbeat",
    "routes",
    "data",
    "events",
    "upgrade",
  ]);
});

test("the error-class enumeration matches docs/CONNECTOR_PROTOCOL.md section 21", () => {
  assert.deepEqual(
    [...ERROR_CLASS_VALUES],
    [
      "ENROLMENT_TOKEN_INVALID",
      "IDENTITY_REVOKED",
      "PROTOCOL_UNSUPPORTED",
      "PROJECT_NOT_AUTHORISED",
      "WORKSPACE_NOT_FOUND",
      "DESTINATION_NOT_ALLOWED",
      "PORT_NOT_LISTENING",
      "ROUTE_LIMIT_EXCEEDED",
      "ROUTE_EXPIRED",
      "STREAM_LIMIT_EXCEEDED",
      "CONTROL_PLANE_UNAVAILABLE",
      "UPGRADE_REQUIRED",
    ],
  );
});

test("version 1 defines exactly the messages the issue scopes", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual(
    [...MESSAGE_TYPE_VALUES],
    [
      "connector.registration.request",
      "connector.registration.response",
      "heartbeat",
      "route.publish",
      "route.publish.ack",
      // docs/CONNECTOR_PROTOCOL.md section 17, ADR-0018. The list is asserted in
      // full rather than by membership so that adding a message type is a
      // deliberate edit here as well as in the schema.
      "connector.reconnect.request",
      "connector.reconnect.response",
    ],
  );
});

test("the envelope carries the fields of section 7", () => {
  const envelope = model.defs.get("envelope");
  assert.ok(envelope !== undefined && envelope.kind === "object");
  assert.deepEqual(
    envelope.properties.map((property) => property.name),
    [
      "protocol_version",
      "message_id",
      "type",
      "sent_at",
      "connector_id",
      "correlation_id",
      "payload",
    ],
  );
});

test("the data-stream header carries the fields of section 12 and no destination", () => {
  const header = model.defs.get("data_stream_header");
  assert.ok(header !== undefined && header.kind === "object");
  assert.deepEqual(
    header.properties.map((property) => property.name),
    [
      "route_id",
      "browser_session_id",
      "session_capability",
      "stream_id",
      "destination_protocol",
      "deadline",
    ],
  );
});

test("every string in the schema has an explicit size bound", () => {
  const unbounded: string[] = [];
  walk(model.defs, (path, node) => {
    if (node.kind === "string" && node.enumValues === null && node.maxLength <= 0) {
      unbounded.push(path);
    }
  });
  assert.deepEqual(unbounded, []);
});

test("every array and numeric field in the schema has an explicit bound", () => {
  const unbounded: string[] = [];
  walk(model.defs, (path, node) => {
    if (node.kind === "array" && node.maxItems <= 0) unbounded.push(path);
    if (
      (node.kind === "integer" || node.kind === "number") &&
      !Number.isFinite(node.maximum)
    ) {
      unbounded.push(path);
    }
  });
  assert.deepEqual(unbounded, []);
});

test("every message payload has a byte bound within the control-frame bound", () => {
  for (const messageType of MESSAGE_TYPE_VALUES) {
    const bound = PAYLOAD_MAX_BYTES[messageType];
    assert.ok(bound > 0, `${messageType} has no payload bound`);
    assert.ok(
      bound <= LIMITS.MAX_CONTROL_FRAME_BYTES,
      `${messageType} may exceed the control-frame bound`,
    );
  }
});

test("no schema field can carry a private key or password", () => {
  const offenders: string[] = [];
  walk(model.defs, (path) => {
    if (/private|secret_key|passphrase|password/iu.test(path)) offenders.push(path);
  });
  assert.deepEqual(offenders, []);
});

test("identifier validation bounds length and character class only, never the prefix", () => {
  const identifier = model.defs.get("identifier");
  assert.ok(identifier !== undefined && identifier.kind === "string");
  assert.ok(identifier.pattern !== null);
  for (const prefix of Object.values(IDENTIFIER_PREFIXES)) {
    assert.ok(
      !identifier.pattern.includes(prefix),
      `the identifier pattern constrains the ${prefix} prefix`,
    );
  }
});

test("the generator refuses a string without a length bound", () => {
  assert.throws(
    () => loadModified((document) => {
      const defs = document["$defs"] as Record<string, Record<string, unknown>>;
      const identifier = defs["identifier"];
      assert.ok(identifier !== undefined);
      delete identifier["maxLength"];
    }),
    (error: unknown) =>
      error instanceof SchemaError && /explicit maxLength bound/u.test(error.message),
  );
});

test("the generator refuses an object that permits additional properties", () => {
  assert.throws(
    () => loadModified((document) => {
      const defs = document["$defs"] as Record<string, Record<string, unknown>>;
      const heartbeat = defs["heartbeat"];
      assert.ok(heartbeat !== undefined);
      heartbeat["additionalProperties"] = true;
    }),
    (error: unknown) =>
      error instanceof SchemaError && /additionalProperties: false/u.test(error.message),
  );
});

test("the generator refuses a keyword it cannot enforce", () => {
  assert.throws(
    () => loadModified((document) => {
      const defs = document["$defs"] as Record<string, Record<string, unknown>>;
      const identifier = defs["identifier"];
      assert.ok(identifier !== undefined);
      identifier["contentEncoding"] = "base64";
    }),
    (error: unknown) => error instanceof SchemaError && /unsupported keyword/u.test(error.message),
  );
});

test("the generator refuses a message type that the enumeration does not list", () => {
  assert.throws(
    () => loadModified((document) => {
      const protocol = document["x-protocol"] as Record<string, unknown>;
      const messages = protocol["messages"] as Record<string, unknown>;
      messages["route.revoke"] = {
        channel: "routes",
        direction: "control_plane_to_connector",
        payload: "heartbeat",
        description: "Added in one place only.",
      };
    }),
    (error: unknown) =>
      error instanceof SchemaError && /does not equal x-protocol.messages keys/u.test(error.message),
  );
});

test("the generator refuses a payload without a byte bound", () => {
  assert.throws(
    () => loadModified((document) => {
      const defs = document["$defs"] as Record<string, Record<string, unknown>>;
      const heartbeat = defs["heartbeat"];
      assert.ok(heartbeat !== undefined);
      delete heartbeat["x-max-bytes"];
    }),
    (error: unknown) =>
      error instanceof SchemaError && /explicit x-max-bytes bound/u.test(error.message),
  );
});

test("the generator refuses a field capable of carrying a private key", () => {
  assert.throws(
    () => loadModified((document) => {
      const defs = document["$defs"] as Record<string, Record<string, unknown>>;
      const request = defs["registration_request"];
      assert.ok(request !== undefined);
      const properties = request["properties"] as Record<string, unknown>;
      properties["private_key"] = { $ref: "#/$defs/public_key" };
    }),
    (error: unknown) =>
      error instanceof SchemaError && /private key or password/u.test(error.message),
  );
});

function loadModified(mutate: (document: Record<string, unknown>) => void): void {
  const document = JSON.parse(model.sourceText) as Record<string, unknown>;
  mutate(document);
  const directory = mkdtempSync(join(tmpdir(), "reviewplane-schema-"));
  const path = join(directory, "v1.schema.json");
  writeFileSync(path, JSON.stringify(document), "utf8");
  loadProtocolModel(path);
}

function walk(
  defs: ReadonlyMap<string, Node>,
  visit: (path: string, node: Node) => void,
): void {
  const visitNode = (path: string, node: Node): void => {
    visit(path, node);
    if (node.kind === "object") {
      for (const property of node.properties) {
        visitNode(`${path}.${property.name}`, property.node);
      }
    }
    if (node.kind === "array") visitNode(`${path}[]`, node.item);
  };
  for (const [defName, node] of defs) visitNode(defName, node);
}

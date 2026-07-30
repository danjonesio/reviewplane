/**
 * Unit layer for the platform foundation (`docs/TESTING.md` section 2:
 * "Protocol validation").
 *
 * The cross-language agreement is the corpus, which `pnpm protocol:check` runs
 * in both languages. What is checked here is the behaviour a corpus cannot
 * express: that an identifier carries no information, that a cursor refuses
 * rather than falls back, and that this codec declines the event types another
 * schema source owns.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CURSOR_VERSION,
  CursorError,
  EVENT_TYPES,
  ERROR_CLASS_VALUES,
  IDENTIFIER_PREFIXES,
  MESSAGE_TYPE_VALUES,
  decodeCursor,
  decodePlatformEvent,
  decodeStreamMessage,
  encodeCursor,
  entityPrefix,
  isEntityId,
  isPlatformEventType,
  newEntityId,
  newPrefixedId,
} from "../src/platform.ts";

test("an identifier is prefix plus randomness and nothing else", () => {
  const first = newEntityId("review");
  assert.match(first, /^rev_[0-9a-f]{32}$/u);
  assert.ok(isEntityId(first));

  // `docs/DOMAIN_MODEL.md` section 3 forbids encoding a timestamp. Identifiers
  // minted in one instant and identifiers minted later must be indistinguishable
  // in every position, so no consumer can come to depend on their order.
  const batch = new Set<string>();
  for (let index = 0; index < 2000; index += 1) batch.add(newEntityId("finding"));
  assert.equal(batch.size, 2000, "identifiers must not repeat");

  const suffixes = [...batch].map((id) => id.slice(4));
  const leadingCharacters = new Set(suffixes.map((suffix) => suffix.slice(0, 1)));
  assert.equal(leadingCharacters.size, 16, "the first random character must span the whole alphabet");
});

test("every documented entity prefix is reachable and the vocabulary is closed", () => {
  for (const [kind, prefix] of Object.entries(IDENTIFIER_PREFIXES)) {
    assert.equal(entityPrefix(kind), prefix);
    assert.ok(newEntityId(kind).startsWith(prefix));
  }
  assert.throws(() => entityPrefix("tenant" as keyof typeof IDENTIFIER_PREFIXES));
});

test("an identifier is bounded by length and character class only", () => {
  assert.ok(isEntityId("anything_without_a_documented_prefix"));
  assert.ok(!isEntityId("rev_has a space"));
  assert.ok(!isEntityId(""));
  assert.ok(!isEntityId("rev_".padEnd(80, "a")));
  assert.ok(!isEntityId(42));
  assert.throws(() => newPrefixedId("has space_"));
});

test("a cursor round-trips and refuses anything this server did not produce", () => {
  const claims = { version: CURSOR_VERSION, sort_key: "2026-07-30T11:24:22.182Z", id: "rev_1" };
  const cursor = encodeCursor(claims);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/u, "a cursor must survive a query string unescaped");

  const decoded = decodeCursor(cursor);
  assert.ok(decoded.ok);
  assert.deepEqual(decoded.value, claims);

  // Every failure is a refusal rather than a silent fall back to the first
  // page: answering with a different page would lose rows without saying so.
  assert.deepEqual(decodeCursor("not base64url!"), { ok: false, reason: "malformed_encoding" });
  assert.deepEqual(decodeCursor("bm90LWpzb24"), { ok: false, reason: "malformed_json" });
  assert.equal(decodeCursor("a".repeat(600)).ok, false);
  assert.throws(
    () => encodeCursor({ ...claims, version: 2 as typeof CURSOR_VERSION }),
    CursorError,
  );
});

test("this codec owns only the event types the schema names, and knows the rest", () => {
  assert.ok(isPlatformEventType("project.created"));
  assert.ok(!isPlatformEventType("review.created"));
  assert.ok(!isPlatformEventType("nonsense.happened"));

  for (const owned of MESSAGE_TYPE_VALUES) {
    assert.ok(
      (EVENT_TYPES as readonly string[]).includes(owned),
      `${owned} is owned by this source but absent from the Stage 1 catalogue`,
    );
  }
  for (const name of EVENT_TYPES) {
    assert.match(name, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u, "docs/EVENTS.md section 6 naming");
  }
});

test("the error vocabulary is exactly the documented one", () => {
  // `docs/MCP_SPEC.md` section 12 plus `VALIDATION_FAILED` from `docs/API.md`
  // section 5. A code the documents do not name must not appear here, because
  // this list is what the server's own vocabulary is derived from.
  assert.equal(new Set(ERROR_CLASS_VALUES).size, ERROR_CLASS_VALUES.length);
  for (const code of ["VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "VALIDATION_FAILED", "RESOURCE_NOT_FOUND"]) {
    assert.ok((ERROR_CLASS_VALUES as readonly string[]).includes(code));
  }
});

test("an event is refused before deserialisation when it exceeds its bound", () => {
  const oversized = `{"padding":"${"a".repeat(40_000)}"}`;
  const result = decodePlatformEvent(oversized);
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "frame_too_large");
});

test("a stream message that is neither an event nor a control message is refused", () => {
  const result = decodeStreamMessage('{"type":"stream.resume","last_sequence":1}');
  assert.ok(!result.ok);
  assert.equal(result.error.reason, "unknown_message_type");
  assert.equal(result.error.errorClass, "UNSUPPORTED_CAPABILITY");
});

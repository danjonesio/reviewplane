/**
 * `docs/SECURITY.md` section 18 forbids raw credentials in logs. The enrolment
 * token and the session capability are the two credentials this protocol
 * carries, so every representation other than the deliberate wire encoding must
 * redact them.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import { readFixture } from "../src/fixtures.ts";
import {
  decodeControlFrame,
  decodeDataStreamHeaderFrame,
  encodeControlFrame,
  encodeDataStreamHeaderFrame,
} from "../src/frame.ts";
import { REDACTED, SensitiveString } from "../src/sensitive.ts";

const SECRET = "MU5vbmNlLTAxSkFCQ0RFRkdISktMTU5PUFFSU1RVVg";

function registrationRequest() {
  const decoded = decodeControlFrame(readFixture({ file: "valid/registration-request.json" }));
  assert.ok(decoded.ok);
  assert.equal(decoded.value.type, "connector.registration.request");
  return decoded.value;
}

test("the enrolment token is redacted in every default representation", () => {
  const frame = registrationRequest();
  const token = frame.payload.enrolment_token;
  assert.equal(token.reveal(), SECRET, "the fixture no longer carries the expected token");

  const representations: Record<string, string> = {
    toString: token.toString(),
    "String()": String(token),
    template: `${token}`,
    concatenation: `` + token,
    "JSON.stringify(token)": JSON.stringify(token),
    "JSON.stringify(payload)": JSON.stringify(frame.payload),
    "JSON.stringify(frame)": JSON.stringify(frame),
    "util.inspect(token)": inspect(token),
    "util.inspect(payload)": inspect(frame.payload, { depth: null }),
    "util.inspect(frame)": inspect(frame, { depth: null }),
    "console.log format": inspect({ event: "registration", frame }, { depth: null }),
  };

  for (const [name, representation] of Object.entries(representations)) {
    assert.ok(!representation.includes(SECRET), `${name} leaked the enrolment token`);
    assert.ok(representation.includes(REDACTED), `${name} carries no redaction marker`);
  }
});

test("the canonical encoding carries the real enrolment token", () => {
  const frame = registrationRequest();
  const encoded = encodeControlFrame(frame);
  assert.ok(encoded.includes(SECRET), "the wire frame must carry the real enrolment token");
});

test("the session capability is redacted", () => {
  const decoded = decodeDataStreamHeaderFrame(readFixture({ file: "valid/data-stream-header.json" }));
  assert.ok(decoded.ok);
  const capability = decoded.value.session_capability.reveal();
  assert.ok(capability.length > 0);

  assert.ok(!JSON.stringify(decoded.value).includes(capability));
  assert.ok(!inspect(decoded.value, { depth: null }).includes(capability));
  assert.ok(encodeDataStreamHeaderFrame(decoded.value).includes(capability));
});

test("a sensitive string reports its length without revealing its value", () => {
  const secret = new SensitiveString("abcdef");
  assert.equal(secret.length, 6);
  assert.equal(secret.toString(), REDACTED);
  assert.equal(secret.reveal(), "abcdef");
});

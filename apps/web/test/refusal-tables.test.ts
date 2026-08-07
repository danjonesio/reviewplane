/**
 * The refusal tables render every stable code their surface can meet
 * (`docs/UX_FLOWS.md` §18).
 *
 * §18 requires a refusal to name the condition and the way out. A code with no
 * entry falls through to the generic panel, which names neither — so the page
 * degrades silently the moment the control plane learns a new refusal, and
 * nothing fails. That is what happened to `IDENTITY_REVOKED`: ADR-0037 made a
 * revoked connector distinguishable from a disconnected one specifically so an
 * operator would stop being told to wait for something that is never coming
 * back, and the web surface would have rendered the fallback for it.
 *
 * The tables are asserted against the codes their own surface raises rather than
 * against every code in the protocol: a table forced to carry codes its surface
 * cannot produce fills with copy nobody reads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BROWSER_SESSION_REFUSALS,
  PUBLICATION_REFUSALS,
} from "../src/components/refusal-tables.ts";

/**
 * What `PublishedServiceService.request` and the connector exchange can refuse
 * a publication with (`docs/API.md` §10, `docs/CONNECTOR_PROTOCOL.md` §21).
 */
const PUBLICATION_CODES = [
  "IDENTITY_REVOKED",
  "CONNECTOR_OFFLINE",
  "CONTROL_PLANE_UNAVAILABLE",
  "DESTINATION_NOT_ALLOWED",
  "ROUTE_LIMIT_EXCEEDED",
  "ROUTE_EXPIRED",
  "WORKSPACE_NOT_FOUND",
  "PORT_NOT_LISTENING",
  "RESOURCE_NOT_FOUND",
  "VALIDATION_FAILED",
];

/** What starting or allocating a browser session can refuse with (§11). */
const BROWSER_SESSION_CODES = [
  "IDENTITY_REVOKED",
  "CONNECTOR_OFFLINE",
  "PUBLISHED_SERVICE_UNAVAILABLE",
  "BROWSER_CAPACITY_EXHAUSTED",
  "BROWSER_SESSION_NOT_ACTIVE",
  "AUTHORISATION_DENIED",
  "RESOURCE_NOT_FOUND",
  "VALIDATION_FAILED",
];

for (const [name, table, codes] of [
  ["publication", PUBLICATION_REFUSALS, PUBLICATION_CODES],
  ["browser session", BROWSER_SESSION_REFUSALS, BROWSER_SESSION_CODES],
] as const) {
  test(`the ${name} refusal table renders every code that surface can meet`, () => {
    const missing = codes.filter((code) => table[code] === undefined);
    assert.deepEqual(missing, [], `${name} falls back to the generic panel for ${missing.join(", ")}`);
    for (const code of codes) {
      const entry = table[code];
      assert.ok((entry?.title.length ?? 0) > 0, `${code} has no title`);
      // The action is the §18 requirement: a refusal that restates the rule and
      // stops is the one this table exists to replace.
      assert.ok((entry?.action.length ?? 0) > 40, `${code}'s action does not say what to do`);
    }
  });
}

test("a revoked identity is not described as something to wait for", () => {
  // The distinction ADR-0037 introduced, asserted where a reader meets it. A
  // revoked enrolment does not dial back in, and telling an operator to wait
  // sends them to watch a connector that will never report.
  for (const table of [PUBLICATION_REFUSALS, BROWSER_SESSION_REFUSALS]) {
    const revoked = table["IDENTITY_REVOKED"];
    const offline = table["CONNECTOR_OFFLINE"];
    assert.ok(revoked !== undefined && offline !== undefined);
    assert.notEqual(revoked.title, offline.title, "revoked and offline read as the same condition");
    assert.doesNotMatch(
      revoked.action,
      /dials back in|usually dials|wait for/iu,
      revoked.action,
    );
    // And it names the act that does help.
    assert.match(revoked.action, /another connector|Enrol/iu, revoked.action);
  }
});

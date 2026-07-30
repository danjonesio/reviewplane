/**
 * The reconnect reconciliation decision table
 * (`docs/CONNECTOR_PROTOCOL.md` §17, `docs/TESTING.md` §2 "Domain transition
 * rules").
 *
 * The table is the security control: it decides which routes survive a
 * reconnect, and getting it wrong in either direction is a real failure. Too
 * permissive and a reconnect extends an authorisation that had lapsed; too
 * strict and every development session dies whenever a laptop sleeps. So every
 * combination of known/unknown route, valid/expired TTL and
 * authorised/unauthorised owner is stated here rather than left to the
 * integration test to discover.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  classifyUpgrade,
  decideSessions,
  reconcileRoutes,
  type AuthoritativeRoute,
  type ClaimedRoute,
} from "../src/modules/connectors/reconciliation.ts";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const CONNECTOR = "con_this";
const OTHER_CONNECTOR = "con_other";

function record(overrides: Partial<AuthoritativeRoute> = {}): AuthoritativeRoute {
  return {
    routeId: "svc_one",
    projectId: "prj_one",
    connectorId: CONNECTOR,
    workspaceId: "wsp_one",
    localHost: "127.0.0.1",
    localPort: 4321,
    protocol: "http",
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    status: "ready",
    allowedBrowserSessionIds: ["brs_one"],
    observedDestination: "127.0.0.1:4321",
    ...overrides,
  };
}

function claim(overrides: Partial<ClaimedRoute> = {}): ClaimedRoute {
  return {
    routeId: "svc_one",
    projectId: "prj_one",
    workspaceId: "wsp_one",
    observedDestination: "127.0.0.1:4321",
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    ...overrides,
  };
}

function decide(claimed: readonly ClaimedRoute[], authoritative: readonly AuthoritativeRoute[]) {
  return reconcileRoutes({ connectorId: CONNECTOR, claimed, authoritative, now: NOW });
}

describe("the reconnect reconciliation decision table", () => {
  test("an unexpired, authorised route the connector claims continues", () => {
    const decisions = decide([claim()], [record()]);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.decision.decision, "continue");
    assert.equal(decisions[0]?.decision.reason, "authorised");
    assert.equal(decisions[0]?.closure, "none");
    // The publication is restated in full, which is what lets a connector that
    // lost its route table resume without a second publication exchange.
    assert.deepEqual(decisions[0]?.decision.route, {
      route_id: "svc_one",
      project_id: "prj_one",
      workspace_id: "wsp_one",
      local_host: "127.0.0.1",
      local_port: 4321,
      protocol: "http",
      expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
      allowed_browser_session_ids: ["brs_one"],
    });
  });

  test("a route the connector lost to a restart still continues", () => {
    // The connector claims nothing. The control plane still holds the route, so
    // it is restored under the same identifier: this is the process-restart case
    // of the Stage 0 exit criterion.
    const decisions = decide([], [record()]);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.decision.decision, "continue");
    assert.equal(decisions[0]?.decision.route?.route_id, "svc_one");
  });

  test("a route the control plane does not know is revoked as unknown", () => {
    const decisions = decide([claim({ routeId: "svc_ghost" })], []);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.decision.decision, "revoke");
    assert.equal(decisions[0]?.decision.reason, "unknown_route");
    // There is no record to end, so no lifecycle transition is invented.
    assert.equal(decisions[0]?.closure, "none");
  });

  test("a route owned by another connector is refused, and that connector's record is untouched", () => {
    const decisions = decide([claim()], [record({ connectorId: OTHER_CONNECTOR })]);
    assert.equal(decisions[0]?.decision.decision, "revoke");
    assert.equal(decisions[0]?.decision.reason, "not_authorised");
    assert.equal(decisions[0]?.closure, "none");
  });

  test("an expired route is closed as expired, not continued", () => {
    const decisions = decide(
      [claim()],
      [record({ expiresAt: new Date(NOW.getTime() - 1000) })],
    );
    assert.equal(decisions[0]?.decision.decision, "revoke");
    assert.equal(decisions[0]?.decision.reason, "expired");
    assert.equal(decisions[0]?.closure, "expired");
  });

  test("a route whose record has already been revoked stays revoked", () => {
    const decisions = decide([claim()], [record({ status: "revoked" })]);
    assert.equal(decisions[0]?.decision.decision, "revoke");
    assert.equal(decisions[0]?.decision.reason, "revoked");
    assert.equal(decisions[0]?.closure, "none");
  });

  test("a destination that disagrees with the record is closed, never continued", () => {
    // docs/ARCHITECTURE.md section 14: traffic is never silently redirected to a
    // different environment. A connector serving a port the record does not name
    // is exactly that.
    const decisions = decide([claim({ observedDestination: "127.0.0.1:9999" })], [record()]);
    assert.equal(decisions[0]?.decision.decision, "revoke");
    assert.equal(decisions[0]?.decision.reason, "destination_mismatch");
    assert.equal(decisions[0]?.closure, "revoked");
  });

  test("a claim that names a different project is refused", () => {
    const decisions = decide([claim({ projectId: "prj_elsewhere" })], [record()]);
    assert.equal(decisions[0]?.decision.decision, "revoke");
    assert.equal(decisions[0]?.decision.reason, "not_authorised");
  });

  test("a claim that names a different workspace is refused", () => {
    const decisions = decide([claim({ workspaceId: "wsp_elsewhere" })], [record()]);
    assert.equal(decisions[0]?.decision.decision, "revoke");
    assert.equal(decisions[0]?.decision.reason, "not_authorised");
  });

  test("a route mid-publication is not something the connector may keep serving", () => {
    const decisions = decide([claim()], [record({ status: "requested" })]);
    assert.equal(decisions[0]?.decision.decision, "revoke");
    assert.equal(decisions[0]?.closure, "revoked");
  });

  test("decisions are deterministic and never duplicated", () => {
    const decisions = decide(
      [claim(), claim(), claim({ routeId: "svc_two" })],
      [record(), record({ routeId: "svc_two" })],
    );
    assert.deepEqual(
      decisions.map((entry) => entry.decision.route_id),
      ["svc_one", "svc_two"],
    );
  });

  test("a revoked decision never carries a publication", () => {
    for (const decisions of [
      decide([claim({ routeId: "svc_ghost" })], []),
      decide([claim()], [record({ expiresAt: new Date(NOW.getTime() - 1) })]),
      decide([claim({ observedDestination: "127.0.0.1:1" })], [record()]),
    ]) {
      assert.equal(decisions[0]?.decision.route, undefined);
    }
  });
});

describe("session decisions", () => {
  test("a session whose route resumed is re-established", () => {
    const decisions = decideSessions(decide([claim()], [record()]));
    assert.deepEqual(decisions, [
      { browser_session_id: "brs_one", decision: "re_establish", reason: "route_resumed" },
    ]);
  });

  test("a session whose only route was closed is ended", () => {
    const decisions = decideSessions(
      decide([claim()], [record({ expiresAt: new Date(NOW.getTime() - 1) })]),
    );
    assert.deepEqual(decisions, [
      { browser_session_id: "brs_one", decision: "end", reason: "route_revoked" },
    ]);
  });

  test("a session with one surviving route keeps it", () => {
    const decisions = decideSessions(
      decide(
        [],
        [
          record({ routeId: "svc_one" }),
          record({ routeId: "svc_two", expiresAt: new Date(NOW.getTime() - 1) }),
        ],
      ),
    );
    assert.deepEqual(decisions, [
      { browser_session_id: "brs_one", decision: "re_establish", reason: "route_resumed" },
    ]);
  });
});

describe("the upgrade classification", () => {
  const policy = { minimumVersion: "0.2.0", recommendedVersion: "0.3.0" };

  test("below the minimum is upgrade_required", () => {
    assert.equal(classifyUpgrade("0.1.9", policy), "upgrade_required");
  });

  test("between the minimum and the recommendation is upgrade_recommended", () => {
    assert.equal(classifyUpgrade("0.2.0", policy), "upgrade_recommended");
  });

  test("at or above the recommendation is compatible", () => {
    assert.equal(classifyUpgrade("0.3.0", policy), "compatible");
    assert.equal(classifyUpgrade("1.0.0", policy), "compatible");
  });

  test("the permissive default accepts every build", () => {
    const open = { minimumVersion: "0.0.0", recommendedVersion: "0.0.0" };
    assert.equal(classifyUpgrade("0.1.0", open), "compatible");
  });
});

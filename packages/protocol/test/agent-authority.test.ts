/**
 * The agent's authority, held across two schema sources.
 *
 * `schemas/review/v1.schema.json` carries the lifecycle tables with their
 * authority column, and is the single source the control plane, the MCP layer
 * and the web application all read (ADR-0024). `schemas/mcp/v1.schema.json`
 * carries the enumerations the agent-facing tools accept. Both describe what an
 * agent may do, and nothing in either file mentions the other, so widening one
 * is a silent change until something compares them.
 *
 * `docs/MCP_SPEC.md` section 7.7 states that the two are held to each other:
 * the six transitions it lists "are the rows naming `agent_session` in
 * `x-protocol.vocabularies.finding_status_transitions`", and that sentence is
 * only true if a test makes it so. This is that test. Widening either table
 * alone fails here.
 *
 * These are the *outer* halves of the authority rule of `AGENTS.md`, which the
 * domain layer enforces again beneath them: a protocol that cannot express a
 * final disposition and a domain that refuses one are two independent reasons an
 * agent cannot accept a human-authored finding, and this file is why the first
 * of them stays true as the tables move.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_REVIEW_STATUS_VALUES, AGENT_TRANSITIONS } from "../src/mcp.ts";
import { findingTransitionsFor, reviewStatusesReachableBy } from "../src/review-transitions.ts";

/**
 * Set comparison, not sequence comparison.
 *
 * The two tables are written in different orders — the review schema groups the
 * finding transitions by source status, the MCP schema follows the order
 * section 7.7 reads in — and neither order is part of the contract. Sorting
 * makes the assertion about membership, which is what authority is.
 */
function asSet(values: readonly string[]): string[] {
  return [...values].sort();
}

test("the finding transitions an agent may request are exactly the rows naming agent_session", () => {
  // The direction that matters most is the review schema growing an
  // `agent_session` row that the MCP layer never advertised: the domain would
  // then permit a transition the protocol documents as impossible. The reverse —
  // the MCP enumeration offering a transition the domain refuses — is a tool
  // that always fails. Equality catches both, and neither table is the one
  // allowed to move first.
  assert.deepEqual(asSet(findingTransitionsFor("agent_session")), asSet(AGENT_TRANSITIONS));
});

test("every review status the MCP tools offer an agent is one the lifecycle lets it reach", () => {
  // Not equality, because `review_update_status` is not the only way an agent
  // moves a review. The lifecycle also lets it reach ASSIGNED, and
  // `docs/MCP_SPEC.md` section 7.6 gives that move to `review_claim` — a tool
  // that claims rather than one that names a status. So the containment is the
  // real contract: nothing the tool accepts may be a status the lifecycle would
  // refuse an agent.
  const reachable = reviewStatusesReachableBy("agent_session");
  for (const status of AGENT_REVIEW_STATUS_VALUES) {
    assert.ok(
      (reachable as readonly string[]).includes(status),
      `review_update_status offers ${status}, which the review table does not let an agent_session reach`,
    );
  }

  // The gap is pinned rather than left open, so that a *new* agent-reachable
  // review status has to be a decision somebody made about the tool rather than
  // one that arrives with a schema edit. If this fails, decide whether the new
  // status belongs in `review_update_status` or beside `review_claim` — and say
  // which in `docs/MCP_SPEC.md` section 7.6.
  const claimOnly = reachable.filter(
    (status) => !(AGENT_REVIEW_STATUS_VALUES as readonly string[]).includes(status),
  );
  assert.deepEqual(asSet(claimOnly), ["ASSIGNED"]);
});

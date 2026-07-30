/**
 * Control-epoch and lease arithmetic (ADR-0007, `docs/TESTING.md` section 5).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { authoriseCommand, isInteractive, isSystemCapture } from "../src/session/control.ts";

const AGENT = { type: "agent", id: "ags_one" } as const;
const OTHER_AGENT = { type: "agent", id: "ags_two" } as const;
const SYSTEM = { type: "system", id: "wkr_one" } as const;

const state = { epoch: 4, controller: AGENT, lastSequence: 10 };

test("a command carrying the current epoch from the lease holder is accepted", () => {
  assert.equal(
    authoriseCommand(state, { command: "click", controller: AGENT, epoch: 4, sequence: 11 }),
    null,
  );
});

test("a stale epoch is rejected with CONTROL_EPOCH_STALE and the current epoch", () => {
  const refusal = authoriseCommand(state, {
    command: "click",
    controller: AGENT,
    epoch: 3,
    sequence: 11,
  });
  assert.ok(refusal !== null);
  assert.equal(refusal.code, "CONTROL_EPOCH_STALE");
  assert.equal(refusal.currentEpoch, 4);
  assert.equal(refusal.retryable, true);
});

test("an epoch from the future is rejected too", () => {
  // A worker that has not been told about a transition cannot act under it.
  const refusal = authoriseCommand(state, {
    command: "navigate",
    controller: AGENT,
    epoch: 5,
    sequence: 11,
  });
  assert.ok(refusal !== null);
  assert.equal(refusal.code, "CONTROL_EPOCH_STALE");
});

test("a replayed sequence is rejected before the lease is considered", () => {
  const refusal = authoriseCommand(state, {
    command: "click",
    controller: AGENT,
    epoch: 4,
    sequence: 10,
  });
  assert.ok(refusal !== null);
  assert.equal(refusal.code, "RESOURCE_STALE");
  assert.equal(refusal.retryable, false);
});

test("an interactive command from a controller without the lease is refused", () => {
  const refusal = authoriseCommand(state, {
    command: "click",
    controller: OTHER_AGENT,
    epoch: 4,
    sequence: 11,
  });
  assert.ok(refusal !== null);
  assert.equal(refusal.code, "CONTROL_NOT_OWNED");
});

test("system capture does not need the interactive lease", () => {
  for (const command of ["snapshot", "take_screenshot"] as const) {
    assert.equal(
      authoriseCommand(state, { command, controller: SYSTEM, epoch: 4, sequence: 11 }),
      null,
      `${command} should be permitted for a system controller`,
    );
  }
});

test("a system controller still cannot issue an interactive command", () => {
  const refusal = authoriseCommand(state, {
    command: "navigate",
    controller: SYSTEM,
    epoch: 4,
    sequence: 11,
  });
  assert.ok(refusal !== null);
  assert.equal(refusal.code, "CONTROL_NOT_OWNED");
});

test("a system capture with a stale epoch is still refused", () => {
  const refusal = authoriseCommand(state, {
    command: "take_screenshot",
    controller: SYSTEM,
    epoch: 1,
    sequence: 11,
  });
  assert.ok(refusal !== null);
  assert.equal(refusal.code, "CONTROL_EPOCH_STALE");
});

test("the two command vocabularies agree with the protocol", () => {
  assert.equal(isInteractive("navigate"), true);
  assert.equal(isInteractive("take_screenshot"), false);
  assert.equal(isSystemCapture("snapshot"), true);
  assert.equal(isSystemCapture("click"), false);
});

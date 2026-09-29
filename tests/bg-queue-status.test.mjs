import assert from "node:assert/strict";
import test from "node:test";
import { STATUS_IN_PROGRESS, STATUS_WAIT_JOIN, STATUS_WAIT_QUEUE } from "../dist/code/world/PvpProtocol.js";
import {
  battlefieldQueueStatus,
  formatDuration,
} from "../dist/code/browser/ui/InteractionPrompts.js";

// G7: the queue rows count instead of standing still — wait with the average, battle clock live.

const queued = (overrides = {}) => ({
  status: STATUS_WAIT_QUEUE, timeInQueue: 90_000, averageWaitTime: 240_000,
  elapsedTime: 0, inviteSecondsLeft: 0, ...overrides,
});

test("durations read as M:SS and never go negative", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(65_000), "1:05");
  assert.equal(formatDuration(3_600_000), "60:00");
  assert.equal(formatDuration(-5000), "0:00");
});

test("a queue row shows the wait and the average, ticking from the snapshot", () => {
  // Rendered at t=1_000_000 with the server's 90 s snapshot: the label at +30 s reads 2:00.
  const bases = { waitBase: 1_000_000 - 90_000, playBase: 0 };
  assert.equal(
    battlefieldQueueStatus(queued(), bases, 1_030_000, false),
    "в очереди 2:00 · среднее 4:00",
  );
  assert.equal(
    battlefieldQueueStatus(queued({ averageWaitTime: 0 }), bases, 1_030_000, false),
    "в очереди 2:00",
    "no average published means no average shown, not a zero one",
  );
  assert.equal(
    battlefieldQueueStatus(queued(), bases, 1_030_000, true),
    "ожидание ответа сервера",
  );
});

test("invites and battles name their own state", () => {
  const bases = { waitBase: 0, playBase: 1_000_000 - 300_000 };
  assert.equal(
    battlefieldQueueStatus(queued({ status: STATUS_WAIT_JOIN, inviteSecondsLeft: 25 }), bases, 1_000_000, false),
    "приглашение",
  );
  assert.equal(
    battlefieldQueueStatus(queued({ status: STATUS_WAIT_JOIN, inviteSecondsLeft: 0 }), bases, 1_000_000, false),
    "приглашение истекло",
  );
  assert.equal(
    battlefieldQueueStatus(queued({ status: STATUS_IN_PROGRESS }), bases, 1_030_000, false),
    "бой идёт 5:30",
  );
});

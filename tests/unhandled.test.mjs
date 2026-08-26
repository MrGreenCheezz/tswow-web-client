import assert from "node:assert/strict";
import test from "node:test";
import { UnhandledOpcodeLog } from "../dist/code/world/UnhandledOpcodes.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { OPCODE_BACKLOG } from "../dist/code/world/OpcodeBacklog.js";

const packet = (opcode, ...bytes) => ({ opcode, payload: Uint8Array.from(bytes) });

test("dropped opcodes are counted, named and sampled", () => {
  const log = new UnhandledOpcodeLog();
  const seen = [];
  log.onFirstSighting = (entry) => seen.push(entry.name);

  log.record(packet(OPCODES.SMSG_LOOT_RESPONSE, 1, 2, 3));
  log.record(packet(OPCODES.SMSG_LOOT_RESPONSE, 4, 5));
  log.record(packet(OPCODES.SMSG_TRAINER_LIST, 9));

  assert.deepEqual(seen, ["SMSG_LOOT_RESPONSE", "SMSG_TRAINER_LIST"]);
  const loot = log.entries.get(OPCODES.SMSG_LOOT_RESPONSE);
  assert.equal(loot.count, 2);
  assert.equal(loot.bytes, 5);
  assert.deepEqual(loot.samples.map((sample) => [...sample]), [[1, 2, 3], [4, 5]]);
  assert.equal(log.missingHandlerCount, 2);
});

test("handshake drops are tracked apart from world-loop drops", () => {
  const log = new UnhandledOpcodeLog();
  log.record(packet(OPCODES.SMSG_MOTD, 1), true);
  log.record(packet(OPCODES.SMSG_MOTD, 1), true);
  log.record(packet(OPCODES.SMSG_MOTD, 1));

  const entry = log.entries.get(OPCODES.SMSG_MOTD);
  assert.equal(entry.droppedDuringLogin, 2);
  assert.equal(entry.count, 1);
  assert.equal(log.missingHandlerCount, 1);
});

test("an opcode TrinityCore does not declare still gets a readable name", () => {
  const log = new UnhandledOpcodeLog();
  log.record(packet(0x7ab, 0xff));
  assert.equal(log.entries.get(0x7ab).name, "UNKNOWN_0x7AB");
});

test("the summary sorts by world-loop frequency and renders samples as hex", () => {
  const log = new UnhandledOpcodeLog();
  log.record(packet(OPCODES.SMSG_TRAINER_LIST, 0x0a, 0xff));
  for (let index = 0; index < 3; index++) log.record(packet(OPCODES.SMSG_LOOT_RESPONSE, index));

  const summary = log.summary();
  assert.deepEqual(summary.map((entry) => entry.name), ["SMSG_LOOT_RESPONSE", "SMSG_TRAINER_LIST"]);
  assert.equal(summary[0].count, 3);
  assert.deepEqual(summary[1].samples, ["0aff"]);
  assert.match(summary[1].opcode, /^0x[0-9A-F]{3,}$/);
});

test("samples stay bounded so a chatty opcode cannot grow without limit", () => {
  const log = new UnhandledOpcodeLog();
  const large = new Uint8Array(4096).fill(7);
  for (let index = 0; index < 50; index++) log.record({ opcode: OPCODES.SMSG_MOTD, payload: large });

  const entry = log.entries.get(OPCODES.SMSG_MOTD);
  assert.equal(entry.count, 50);
  assert.equal(entry.samples.length, 4);
  for (const sample of entry.samples) assert.equal(sample.length, 256);

  log.clear();
  assert.equal(log.entries.size, 0);
});

test("a dropped packet names the plan slice that owes its handler", () => {
  const log = new UnhandledOpcodeLog();
  // Whatever is still outstanding: naming one opcode here would only mean rewriting this test the
  // day it gets a handler. Since slice P9 the backlog is empty and there is nothing left to owe,
  // so this branch is dormant rather than gone — it wakes up the day a core upgrade adds an
  // opcode and the ratchet demands an owner for it.
  const outstanding = [...OPCODE_BACKLOG][0];
  if (outstanding) {
    const [name, slice] = outstanding;
    log.record({ opcode: OPCODES[name], payload: Uint8Array.of(1) });
    assert.equal(log.summary().find((entry) => entry.name === name).slice, slice);
  }

  // With nothing outstanding, a live opcode that somehow went unhandled is unplanned by
  // definition: no slice claims it, because every slice is closed.
  log.record({ opcode: OPCODES.SMSG_MOTD, payload: Uint8Array.of(1) });
  // An opcode number TrinityCore does not declare has no name, so it cannot have an owner either.
  log.record({ opcode: 0xfffe, payload: Uint8Array.of(1) });

  const summary = log.summary();
  assert.equal(summary.find((entry) => entry.name === "SMSG_MOTD").slice, "unplanned");
  assert.equal(summary.find((entry) => entry.name.startsWith("UNKNOWN_")).slice, "unplanned");
});

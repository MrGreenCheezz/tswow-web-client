import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/index.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { PacketErrorLog } from "../dist/code/world/PacketErrors.js";
import { buildPacketDiagnosticsReport } from "../dist/code/browser/ui/PacketDiagnosticsReport.js";

test("a malformed handled packet stays distinct from an opcode with no handler", async () => {
  const malformed = Uint8Array.of(0);
  const connection = {
    packets: [
      {
        opcode: OPCODES.SMSG_LOGIN_VERIFY_WORLD,
        payload: new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array(),
      },
      { opcode: OPCODES.SMSG_LOGIN_SET_TIME_SPEED, payload: malformed },
      { opcode: 0x7fff, payload: Uint8Array.of(0xaa) },
      { opcode: OPCODES.SMSG_LOGIN_SET_TIME_SPEED, payload: malformed },
      { opcode: OPCODES.CMSG_EMOTE, payload: Uint8Array.of(0) },
    ],
    send() {},
    read() { return this.packets.length ? Promise.resolve(this.packets.shift()) : new Promise(() => {}); },
    close() {},
  };
  const client = new WorldClient(connection);
  const errors = [];
  let changed = 0;
  client.onPacketError = (opcode, error) => errors.push([opcode, error.message]);
  client.onPacketErrorsChanged = () => { changed++; };

  await client.loginCharacter(1n);
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.unhandledOpcodes.missingHandlerCount, 1);
  assert.equal(client.unhandledOpcodes.entries.has(OPCODES.SMSG_LOGIN_SET_TIME_SPEED), false);
  assert.equal(client.unhandledOpcodes.entries.get(0x7fff)?.count, 1);
  assert.equal(client.packetErrors.count, 3);
  assert.equal(changed, 3);
  const parseError = client.packetErrors.summary().find(({ name }) => name === "SMSG_LOGIN_SET_TIME_SPEED");
  assert.equal(parseError?.count, 2);
  assert.equal(parseError?.category, "dispatch");
  assert.deepEqual(parseError?.payloadSizes, [1, 1]);
  assert.equal(Object.hasOwn(parseError, "samples"), false, "reports keep no packet bytes");
  assert.equal(client.packetErrors.summary().find(({ name }) => name === "CMSG_EMOTE")?.category, "custom-transport");
  assert.deepEqual(errors.map(([opcode]) => opcode), [
    OPCODES.SMSG_LOGIN_SET_TIME_SPEED,
    OPCODES.SMSG_LOGIN_SET_TIME_SPEED,
    OPCODES.CMSG_EMOTE,
  ]);
  client.close();
});

test("a long stream of distinct parser failures remains bounded without hiding the total", () => {
  const log = new PacketErrorLog();
  for (let index = 0; index < 129; index++) log.record(OPCODES.SMSG_PONG, new Error(`layout ${index}`));
  log.record(OPCODES.SMSG_PONG, new Error("layout 0"));
  assert.equal(log.count, 130);
  assert.equal(log.omitted, 1);
  assert.equal(log.summary().length, 128);
  assert.equal(log.summary().find(({ message }) => message === "layout 0")?.count, 2);
});

test("downloadable packet report keeps counters but excludes payloads, decoded values and character identity", () => {
  const secret = "PRIVATE_SESSION_TOKEN";
  const hexSecret = Buffer.from(secret).toString("hex");
  const world = {
    mapId: 0,
    state: { selfGuid: 123456789n },
    unhandledOpcodes: {
      missingHandlerCount: 1,
      summary: () => [{
        opcode: "0x777", name: "SMSG_EXAMPLE", slice: "unplanned", count: 2,
        droppedDuringLogin: 0, bytes: 64, samples: [hexSecret],
      }],
    },
    packetErrors: {
      count: 1,
      omitted: 0,
      summary: () => [{
        opcode: "0x778", name: "SMSG_BAD", category: "dispatch", message: secret, count: 1,
        firstSeen: 10, lastSeen: 10, payloadSizes: [secret.length], samples: [hexSecret],
      }],
    },
    customPackets: {
      summary: () => [{
        opcode: 42, name: "example", module: "mod", direction: "in", claimed: true, declared: true,
        received: 3, receivedBytes: 48, sent: 1, sentBytes: 8, decoded: 3, failed: 0,
        remainder: 0, error: secret, firstSeen: 10, lastSeen: 20,
        value: { token: secret, id: 123n }, samples: [hexSecret],
      }],
    },
  };

  const report = buildPacketDiagnosticsReport(world, "2026-09-23T00:00:00.000Z");
  const json = JSON.stringify(report);
  assert.equal(report.handlerCount, 1);
  assert.equal(report.opcodes[0].bytes, 64);
  assert.equal(report.packetErrors[0].payloadSizes[0], secret.length);
  assert.equal(report.packetErrors[0].category, "dispatch");
  assert.equal(report.customPackets[0].receivedBytes, 48);
  assert.equal(Object.hasOwn(report, "selfGuid"), false);
  assert.equal(Object.hasOwn(report.opcodes[0], "samples"), false);
  assert.equal(Object.hasOwn(report.packetErrors[0], "samples"), false);
  assert.equal(Object.hasOwn(report.packetErrors[0], "message"), false);
  assert.equal(Object.hasOwn(report.customPackets[0], "samples"), false);
  assert.equal(Object.hasOwn(report.customPackets[0], "value"), false);
  assert.equal(Object.hasOwn(report.customPackets[0], "error"), false);
  assert.doesNotMatch(json, new RegExp(`${secret}|${hexSecret}|123456789`));
});

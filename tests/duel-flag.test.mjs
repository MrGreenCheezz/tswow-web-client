import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DUEL_BACK_IN_BOUNDS_YARDS,
  DUEL_OUT_OF_BOUNDS_YARDS,
  DUEL_SPELL_ID,
  buildDuelResponse,
  parseDuelCountdown,
  parseDuelRequested,
} from "../dist/code/world/DuelProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";
import { OPCODES } from "../dist/code/generated/opcodes.js";

// Q2: the duel flag plants a 50-yard ring on the world — the server's own out-of-bounds
// distance, not a number from the client's head.

function duelRequested(flagGuid, challengerGuid) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, flagGuid, true);
  view.setBigUint64(8, challengerGuid, true);
  return bytes;
}

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) {
        const resume = wake;
        wake = undefined;
        resume(queue.shift());
      }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}

async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}

async function loggedIn() {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new (await import("../dist/code/protocol/PacketWriter.js")).PacketWriter()
      .u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  return { client, connection };
}

test("the bounds radii are the core's CheckDuelDistance numbers", () => {
  // Player.cpp:7378 out at 50, Player.cpp:7388 back in at 40. The ring draws the outer one.
  assert.equal(DUEL_OUT_OF_BOUNDS_YARDS, 50);
  assert.equal(DUEL_BACK_IN_BOUNDS_YARDS, 40);
});

test("the request names the flag both sides can anchor on", async () => {
  // SMSG_DUEL_REQUESTED carries the flag guid to the challenger and the challenged alike
  // (SpellEffects.cpp:4021-4025), so either side can draw the ring.
  const requested = duelRequested(0x5n, 0x9n);
  assert.deepEqual(parseDuelRequested(requested), { flagGuid: 0x5n, challengerGuid: 0x9n });
  assert.equal(parseDuelCountdown(Uint8Array.from([3, 0, 0, 0])), 3);
  assert.equal(DUEL_SPELL_ID, 7266);
  const response = buildDuelResponse(0x5n);
  assert.equal(response.length, 8);
  assert.equal(new DataView(response.buffer, response.byteOffset).getBigUint64(0, true), 0x5n);
});

test("request, accept, bounds and finish move the flag through its life", async () => {
  const { client, connection } = await loggedIn();
  try {
    connection.push(OPCODES.SMSG_DUEL_REQUESTED, duelRequested(0x5n, 0x9n));
    await settle();
    assert.equal(client.duelFlag, 0x5n, "the prompt names the flag");
    assert.notEqual(client.duelRequest, undefined);

    client.answerDuel(true);
    await settle();
    assert.equal(client.duelRequest, undefined, "the prompt is answered");
    assert.equal(client.duelFlag, 0x5n, "but the ring keeps its anchor for the fight");

    connection.push(OPCODES.SMSG_DUEL_OUTOFBOUNDS, new Uint8Array(0));
    await settle();
    assert.equal(client.duelInBounds, false);

    connection.push(OPCODES.SMSG_DUEL_INBOUNDS, new Uint8Array(0));
    await settle();
    assert.equal(client.duelInBounds, true);

    connection.push(OPCODES.SMSG_DUEL_COMPLETE, Uint8Array.from([1]));
    await settle();
    assert.equal(client.duelFlag, undefined, "the finished duel takes its ring down");
    assert.equal(client.duelInBounds, undefined);
  } finally {
    client.close();
  }
});

test("declining drops the flag with the prompt", async () => {
  const { client, connection } = await loggedIn();
  try {
    connection.push(OPCODES.SMSG_DUEL_REQUESTED, duelRequested(0x5n, 0x9n));
    await settle();
    client.answerDuel(false);
    assert.equal(client.duelFlag, undefined, "no duel, no bounds, no ring");
  } finally {
    client.close();
  }
});

test("the loop resolves the flag to a ring, the renderer draws it at fifty", async () => {
  const loop = await readFile(new URL("../src/browser/game/Loop.ts", import.meta.url), "utf8");
  assert.match(loop, /world\.duelFlag/, "the frame sync reads the retained flag");
  assert.match(loop, /setDuelRing/, "and pushes it where the selection rings go");
  assert.match(loop, /duelInBounds !== false/, "unknown bounds read as inside, not as alarming");
  const renderer = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(renderer, /DUEL_OUT_OF_BOUNDS_YARDS/, "the drawn radius is the protocol constant");
  assert.match(renderer, /#updateDuelRing\(heightAt\)/, "laid on the ground like every other ring");
  assert.match(renderer, /ring\.inBounds \? 0x63d6a0 : 0xff5f4a/, "green inside, reticle-red outside");
});

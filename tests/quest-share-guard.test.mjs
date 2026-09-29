import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

// G2: the journal already abandons (with confirm), shares and tracks/untracks — the remaining
// gap was a Share button that answered a solo click with server-side silence.

function fakeConnection() {
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() { return new Promise(() => {}); },
    close() {},
  };
}

test("shareQuest reaches the wire for a sane id and rejects the rest locally", () => {
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  world.shareQuest(1234);
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].opcode, OPCODES.CMSG_PUSHQUESTTOPARTY);
  world.shareQuest(0);
  world.shareQuest(-5);
  world.shareQuest(Number.NaN);
  assert.equal(connection.sent.length, 1, "garbage ids never reach the server");
  world.close();
  world.shareQuest(1234);
  assert.equal(connection.sent.length, 1, "a closed client stays silent");
});

test("the journal Share button is gated on having somebody to share with", async () => {
  const source = await readFile(new URL("../src/browser/ui/QuestLog.ts", import.meta.url), "utf8");
  assert.match(
    source, /world\?\.group\?\.members\.length/,
    "sharing reads the group roster, whose member list excludes the player",
  );
  assert.match(
    source, /share\.disabled = !shareable/,
    "outside a group the button is disabled rather than silently refused",
  );
  assert.match(source, /Вне группы делиться не с кем/, "the reason is spelled out");
});

import assert from "node:assert/strict";
import test from "node:test";

// 4.03 / 6.09: «Отображать шлем / плащ». The core reads one bool byte (CharacterPackets.cpp) and
// answers only through PLAYER_FLAGS, so the client sends the byte and writes nothing locally.
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");

function fakeConnection() {
  return {
    sent: [],
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload: [...payload] }); },
    read: () => new Promise(() => {}),
    close() {},
  };
}

test("setShowingHelm/Cloak send CMSG_SHOWING_HELM 0x2B9 / CMSG_SHOWING_CLOAK 0x2BA with one byte", () => {
  assert.equal(OPCODES.CMSG_SHOWING_HELM, 0x2b9);
  assert.equal(OPCODES.CMSG_SHOWING_CLOAK, 0x2ba);
  const connection = fakeConnection();
  const world = new WorldClient(connection);
  world.setShowingHelm(false);
  world.setShowingHelm(true);
  world.setShowingCloak(false);
  world.setShowingCloak(true);
  assert.deepEqual(connection.sent, [
    { opcode: 0x2b9, payload: [0] },
    { opcode: 0x2b9, payload: [1] },
    { opcode: 0x2ba, payload: [0] },
    { opcode: 0x2ba, payload: [1] },
  ]);
  assert.equal(world.state.objects.size, 0, "no local flag write: the field update is the answer");
});

import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import {
  FRIEND_ADDED_OFFLINE, FRIEND_IGNORE_ADDED, FRIEND_IGNORE_REMOVED, FRIEND_REMOVED,
  SOCIAL_FLAG_ALL, SOCIAL_FLAG_FRIEND, SOCIAL_FLAG_IGNORED,
} from "../dist/code/world/ContactProtocol.js";
import { WorldClient } from "../dist/code/world/WorldClient.js";

const PLAYER = 0x1234n;
const CONTACT = 0x5678n;

function connection() {
  const packets = [];
  let resume;
  return {
    send() {},
    close() {},
    push(opcode, payload) {
      const packet = { opcode, payload };
      if (resume) {
        const wake = resume;
        resume = undefined;
        wake(packet);
      } else packets.push(packet);
    },
    read() {
      if (packets.length) return Promise.resolve(packets.shift());
      return new Promise((resolve) => { resume = resolve; });
    },
  };
}

async function settle() {
  for (let pass = 0; pass < 6; pass++) await new Promise((resolve) => setImmediate(resolve));
}

async function loggedIn() {
  const transport = connection();
  transport.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD,
    new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(transport);
  await client.loginCharacter(PLAYER);
  await settle();
  return { client, transport };
}

function contactList(flags) {
  return new PacketWriter().u32(SOCIAL_FLAG_ALL).u32(1)
    .u64(CONTACT).u32(flags).cString("знакомый")
    .u8(1).u32(1519).u32(80).u32(8).toUint8Array();
}

function status(result, guid = CONTACT, note = "") {
  const packet = new PacketWriter().u8(result).u64(guid);
  if (result === FRIEND_ADDED_OFFLINE) packet.cString(note);
  return packet.toUint8Array();
}

test("friend and ignore status packets change one flag, preserving the other", async () => {
  const { client, transport } = await loggedIn();
  try {
    transport.push(OPCODES.SMSG_CONTACT_LIST, contactList(SOCIAL_FLAG_FRIEND | SOCIAL_FLAG_IGNORED));
    await settle();
    assert.equal(client.contacts.contacts[0].flags, SOCIAL_FLAG_FRIEND | SOCIAL_FLAG_IGNORED);

    transport.push(OPCODES.SMSG_FRIEND_STATUS, status(FRIEND_IGNORE_REMOVED));
    await settle();
    assert.equal(client.contacts.contacts[0]?.flags, SOCIAL_FLAG_FRIEND,
      "removing ignore keeps the friend and online details");

    transport.push(OPCODES.SMSG_FRIEND_STATUS, status(FRIEND_IGNORE_ADDED));
    await settle();
    assert.equal(client.contacts.contacts[0]?.flags, SOCIAL_FLAG_FRIEND | SOCIAL_FLAG_IGNORED,
      "adding ignore to a friend sets the second flag");

    transport.push(OPCODES.SMSG_FRIEND_STATUS, status(FRIEND_REMOVED));
    await settle();
    assert.equal(client.contacts.contacts[0]?.flags, SOCIAL_FLAG_IGNORED,
      "removing friend keeps the ignore");

    transport.push(OPCODES.SMSG_FRIEND_STATUS, status(FRIEND_ADDED_OFFLINE, CONTACT, "снова друг"));
    await settle();
    assert.equal(client.contacts.contacts[0]?.flags, SOCIAL_FLAG_FRIEND | SOCIAL_FLAG_IGNORED,
      "adding friend to an ignored player sets the first flag");
    assert.equal(client.contacts.contacts[0]?.note, "снова друг");
  } finally {
    client.close();
  }
});

test("a refused friend request never creates a contact", async () => {
  const { client, transport } = await loggedIn();
  try {
    transport.push(OPCODES.SMSG_CONTACT_LIST, new PacketWriter().u32(SOCIAL_FLAG_ALL).u32(0).toUint8Array());
    await settle();
    // FRIEND_ENEMY carries the resolved character GUID even though the server did not add them.
    transport.push(OPCODES.SMSG_FRIEND_STATUS, status(0x0a));
    await settle();
    assert.deepEqual(client.contacts.contacts, []);
  } finally {
    client.close();
  }
});

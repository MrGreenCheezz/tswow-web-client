import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { PacketWriter } from "../dist/code/protocol/PacketWriter.js";
import { settle, travelClient } from "./fixtures/world-packets.mjs";

// Plan item 2.05 (13.10): is waiting wrapping paper let go on a map change? Wow.exe keeps the paper's guid in
// DAT_00c9ead0 and writes it in three places only (read-only Ghidra, .runtime/re-2026-10-11/glue-1110/a205-3…6.txt):
// the arming 0x006d67e0, the release 0x006cef80 (from the cursor reset 0x00519280 and a sent wrap 0x006dcf20) and
// ClientInitializeGame's 0x006e45d0 (entering the world). Leaving a map — the active player's removal 0x006e6020 →
// 0x00528c30 — resets mirror timers, the selection and the focus, and no cursor; the re-created player's 0x00520f70
// resets the cursor (and the paper) only when that player has no health. So a living player's paper waits through a
// map change, and the next bag click after the loading screen wraps with it, found again by its guid. This client
// binds the paper to the world client, which a map change keeps: the same answer.
const wrap = await import("../dist/code/browser/game/GiftWrap.js");

const SELF = 0x10n;
const PAPER = 0x4000_0000_0000_0901n;

test("waiting wrapping paper survives SMSG_NEW_WORLD; a new world client (a new login) does not keep it", async () => {
  const { client, connection } = await travelClient([], SELF);
  const other = (await travelClient([], SELF)).client;
  try {
    wrap.cancelGiftWrap();
    assert.equal(wrap.armGiftWrap(client, { bag: 255, slot: 23, guid: PAPER }), true);
    connection.push(OPCODES.SMSG_NEW_WORLD, new PacketWriter().u32(571).f32(1).f32(2).f32(3).f32(0).toUint8Array());
    await settle();
    assert.equal(client.mapId, 571, "the map changed");
    assert.equal(wrap.pendingGiftWrap(client)?.guid, PAPER, "the paper still waits (no 0x00519280 on the way)");
    assert.equal(wrap.pendingGiftWrap(other), undefined, "another world entry: let go (0x006e45d0)");
    assert.equal(wrap.giftWrapPending(), false);
  } finally {
    wrap.cancelGiftWrap();
    client.close?.();
    other.close?.();
  }
});

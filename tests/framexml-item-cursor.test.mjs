import assert from "node:assert/strict";
import test from "node:test";

const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { clickFrameXmlNativeBankSlot, publishFrameXmlNativeBankCursor } =
  await import("../dist/code/browser/framexml/FrameXmlItemCursorBridge.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

function place(fields, offset, guid) {
  fields.set(offset, Number(guid & 0xffffffffn));
  fields.set(offset + 1, Number(guid >> 32n));
}

function fixture() {
  const player = { guid: 1n, fields: new Map() };
  const item = { guid: 2n, fields: new Map([[UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, 13446]]) };
  place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, item.guid);
  const sent = [];
  const world = {
    state: { selfGuid: player.guid, objects: new Map([[player.guid, player], [item.guid, item]]) },
    bankerGuid: 3n,
    moveItem: (...args) => sent.push(args),
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const release = publishFrameXmlNativeBankCursor({
    clickBankSlot: ({ bag, slot }) => seam.clickNativeBankSlot(bag, slot),
  });
  return { player, item, world, seam, sent, release };
}

test("stock bag cursor deposits into the native bank and withdraws to the same stock bag slot", () => {
  const { player, seam, sent, release } = fixture();
  try {
    assert.deepEqual(call("PickupContainerItem", seam, 0, 1), []);
    assert.deepEqual(call("CursorHasItem", seam), [true]);
    assert.deepEqual(call("GetCursorInfo", seam).slice(0, 2), ["item", 13446]);
    assert.deepEqual(sent, [], "picking up is local and sends no packet");
    assert.equal(clickFrameXmlNativeBankSlot({ bag: 255, slot: 67 }), false,
      "a bank bag slot which the player has not bought is not a destination");
    assert.deepEqual(sent, []);

    assert.equal(clickFrameXmlNativeBankSlot({ bag: 255, slot: 39 }), true);
    assert.deepEqual(sent, [[255, 23, 255, 39]], "the existing server-authoritative swap names exact slots");
    assert.deepEqual(call("CursorHasItem", seam), [false]);

    // Model the server's update before the reverse click. The cursor never moves fields itself.
    place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 0n);
    place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_BANK_SLOT_1.offset, 2n);
    assert.equal(clickFrameXmlNativeBankSlot({ bag: 255, slot: 39 }), true);
    assert.deepEqual(call("GetCursorInfo", seam).slice(0, 2), ["item", 13446]);
    call("PickupContainerItem", seam, 0, 1);
    assert.deepEqual(sent, [[255, 23, 255, 39], [255, 39, 255, 23]]);
    assert.deepEqual(call("CursorHasItem", seam), [false]);
  } finally {
    release();
  }
});

test("stock cursor cancellation, stale GUID and absent banker never move an item", () => {
  const { player, world, seam, sent, release } = fixture();
  try {
    assert.equal(clickFrameXmlNativeBankSlot({ bag: 255, slot: 38 }), false,
      "the bank bridge only owns bank slots");
    call("PickupContainerItem", seam, 0, 1);
    call("ClearCursor", seam);
    assert.deepEqual(call("GetCursorInfo", seam), []);
    assert.equal(clickFrameXmlNativeBankSlot({ bag: 255, slot: 39 }), false,
      "an empty bank slot with no cursor stays with the native panel");

    call("PickupContainerItem", seam, 0, 1);
    place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 0n);
    assert.deepEqual(call("CursorHasItem", seam), [false], "a source changed by the realm is stale");
    assert.equal(clickFrameXmlNativeBankSlot({ bag: 255, slot: 39 }), false);

    place(player.fields, UPDATE_FIELDS.PLAYER_FIELD_PACK_SLOT_1.offset, 2n);
    call("PickupContainerItem", seam, 0, 1);
    world.bankerGuid = undefined;
    assert.equal(clickFrameXmlNativeBankSlot({ bag: 255, slot: 39 }), false);
    assert.deepEqual(call("CursorHasItem", seam), [true],
      "a carried source remains selected until the world event or mount cleanup clears it");
    seam.detach();
    assert.deepEqual(call("CursorHasItem", seam), [false]);
    assert.deepEqual(sent, []);
  } finally {
    release();
  }
});

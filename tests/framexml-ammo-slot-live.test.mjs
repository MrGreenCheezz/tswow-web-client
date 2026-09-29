import assert from "node:assert/strict";
import test from "node:test";

// The stock AmmoSlot and bags from the retail 3.3.5a MPQ over LiveWorldSeam, a real WorldClient and
// a real WorldStore: a right click on arrows in the backpack goes out as CMSG_SET_AMMO, the realm's
// PLAYER_AMMO_ID answer repaints CharacterAmmoSlot through UNIT_INVENTORY_CHANGED, a spent arrow
// moves its count on the 60 ms poll, and a drop on the slot is CMSG_SET_AMMO again. Everything
// compared is a primitive read back from Lua: a bridge frame handed to assert inspects the whole
// widget graph on a mismatch.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { clientDirectory } = await import("../tools/paths.mjs");
const { openClientArchives } = await import("../tools/mpq.mjs");

let clientDir;
try {
  clientDir = clientDirectory();
} catch {
  clientDir = undefined;
}

const PLAYER = 0x10n;
const ARROWS = 0x201n;
const ARROW_ICON = "Interface\\Icons\\INV_Ammo_Arrow_02";
const offset = (name) => UPDATE_FIELDS[name].offset;

function worldFixture() {
  const sent = [];
  const world = new WorldClient({
    // A bodiless opcode (CMSG_REQUEST_RAID_INFO at load) comes without a payload.
    send(opcode, payload = new Uint8Array()) { sent.push([opcode, [...payload]]); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const fields = new Map([
    // race=Human, class=Hunter, gender=male, power=MANA
    [offset("UNIT_FIELD_BYTES_0"), 1 | (3 << 8)],
    [offset("UNIT_FIELD_LEVEL"), 20],
    [offset("UNIT_FIELD_HEALTH"), 400],
    [offset("UNIT_FIELD_MAXHEALTH"), 500],
    [offset("UNIT_FIELD_POWER1"), 250],
    [offset("UNIT_FIELD_MAXPOWER1"), 300],
    [offset("PLAYER_XP"), 100],
    [offset("PLAYER_NEXT_LEVEL_XP"), 1000],
    // Rough Arrow ×200 in backpack slot 1 (wire 255/23).
    [offset("PLAYER_FIELD_PACK_SLOT_1"), Number(ARROWS)],
    [offset("PLAYER_FIELD_PACK_SLOT_1") + 1, 0],
  ]);
  state.objects.set(PLAYER, {
    guid: PLAYER, typeId: 4, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined,
    runSpeed: undefined, turnRate: undefined, motion: undefined, glide: undefined, transport: undefined,
    speeds: undefined, transportTime: undefined, fields,
  });
  const arrowFields = new Map([[offset("OBJECT_FIELD_ENTRY"), 2512], [offset("ITEM_FIELD_STACK_COUNT"), 200]]);
  state.objects.set(ARROWS, { guid: ARROWS, typeId: 1, fields: arrowFields });
  state.selfGuid = PLAYER;
  // Made after the character is in place, as a logged-in session has it: a store that saw the self
  // guid arrive notifies every player-field subscriber on its first flush, which is login's edge
  // family, not this test's.
  const store = new WorldStore(state);
  // Rough Arrow as this realm's item_template has it: class 6, subclass 2, INVTYPE_AMMO.
  world.itemTemplates.set(2512, {
    entry: 2512, found: true, name: "Грубая стрела", quality: 1, itemClass: 6, subClass: 2, flags: 0,
    inventoryType: 24, bonding: 0, stackable: 200, bagFamily: 0, spells: [], itemLevel: 5, requiredLevel: 1,
    containerSlots: 0, maxDurability: 0, pageText: 0, startQuest: 0,
  });
  world.mapId = 0;
  world.selfName = "Флик";
  world.knownSpells = [{ id: 1, slot: 0 }];
  const realmTime = { minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60,
    weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  return { world, store, fields, arrowFields, sent };
}

test("stock AmmoSlot and bags over the live seam: CMSG_SET_AMMO out, PLAYER_AMMO_ID and the count back in", {
  skip: clientDir ? false : "no 3.3.5a client on this machine",
}, async () => {
  const chain = await openClientArchives(clientDir);
  const decoder = new TextDecoder("utf-8");
  const { world, store, fields, arrowFields, sent } = worldFixture();
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: (id) => ({ id, name: "Проверочное заклинание", rank: "", iconPath: "Interface\\Icons\\Spell_Test" }),
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
    itemTexture: (entry) => (entry === 2512 ? ARROW_ICON : undefined),
  });
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const bytes = await chain.read(path);
        return bytes ? decoder.decode(bytes) : undefined;
      },
    },
    locale: "ruRU",
    subset: FRAMEXML_VERTICAL_TOC,
    seam,
    screen: () => ({ width: 1024, height: 768 }),
    // A stand-in for the mount's item tooltips: the seam's own slot answer, titled by its template.
    gameTooltipAdapter: {
      inventoryItem: (unit, slot) => {
        const item = seam.inventoryItemTooltip(unit, slot);
        return item?.template ? { title: item.template.name } : undefined;
      },
      containerItem: () => undefined,
    },
  });
  const ammoSlot = () => {
    const probe = boot.vm.execute(`
      __ammoVisible = CharacterAmmoSlot:IsVisible() and true or false
      __ammoTexture = CharacterAmmoSlotIconTexture:GetTexture()
      __ammoCount = CharacterAmmoSlotCount:IsShown() and CharacterAmmoSlotCount:GetText() or false
      __ammoHasItem = CharacterAmmoSlot.hasItem == 1
    `, "@ammo-slot:probe");
    assert.equal(probe.ok, true, probe.error);
    return {
      visible: boot.vm.getGlobal("__ammoVisible"),
      texture: String(boot.vm.getGlobal("__ammoTexture")),
      count: boot.vm.getGlobal("__ammoCount"),
      hasItem: boot.vm.getGlobal("__ammoHasItem"),
    };
  };
  const setAmmoPackets = () => sent.filter(([opcode]) => opcode === OPCODES.CMSG_SET_AMMO).map(([, bytes]) => bytes.join(","));
  const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`);
  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.errors, [], "vertical inventory has no handled Lua failures");
    const character = boot.bridge.getFrame("CharacterFrame");
    assert.equal(character?.name, "CharacterFrame");
    assert.equal(boot.bridge.Show(character), true);
    assert.deepEqual(failures(), [], "CharacterFrame shown");

    const empty = ammoSlot();
    assert.equal(empty.visible, true, "no relic slot (PaperDollFrame_OnShow): the AmmoSlot shows");
    assert.equal(empty.hasItem, false, "PLAYER_AMMO_ID 0: the slot is empty");
    assert.match(empty.texture, /UI-PaperDoll-Slot-Ammo/i, "the AmmoSlot's own background (GetInventorySlotInfo)");

    // ContainerFrameItemButton_OnClick's right button: UseContainerItem(0, 1).
    const click = boot.vm.execute("UseContainerItem(0, 1)", "@ammo-slot:right-click");
    assert.equal(click.ok, true, click.error);
    assert.deepEqual(setAmmoPackets(), ["208,9,0,0"], "CMSG_SET_AMMO 0x268 with Rough Arrow (2512)");
    assert.equal(sent.some(([opcode]) => opcode === OPCODES.CMSG_AUTOEQUIP_ITEM || opcode === OPCODES.CMSG_USE_ITEM), false);
    assert.deepEqual(failures(), [], "the right click");

    // The realm's answer: Player::SetAmmo writes PLAYER_AMMO_ID; the store delivers it on flush.
    fields.set(offset("PLAYER_AMMO_ID"), 2512);
    store.fieldsChanged(PLAYER, [offset("PLAYER_AMMO_ID")]);
    store.flush();
    const set = ammoSlot();
    assert.equal(set.hasItem, true);
    assert.equal(set.texture, ARROW_ICON);
    assert.equal(set.count, "200", "SetItemButtonCount shows the carried count (maxDisplayCount 999)");
    assert.deepEqual(failures(), [], "PLAYER_AMMO_ID delivered");

    // The hover: PaperDollItemSlotButton_OnEnter asks GameTooltip:SetInventoryItem("player", 0), and
    // only a refusal falls back to the slot's own «Боеприпасы» label.
    const hover = boot.vm.execute(`
      PaperDollItemSlotButton_OnEnter(CharacterAmmoSlot)
      __tip = GameTooltipTextLeft1:GetText()
      PaperDollItemSlotButton_OnLeave(CharacterAmmoSlot)
    `, "@ammo-slot:hover");
    assert.equal(hover.ok, true, hover.error);
    assert.equal(boot.vm.getGlobal("__tip"), "Грубая стрела", "the arrow's own tooltip on the AmmoSlot");

    // One shot: Spell.cpp spends an arrow with DestroyItemCount; the 60 ms poll repaints the count.
    arrowFields.set(offset("ITEM_FIELD_STACK_COUNT"), 199);
    store.fieldsChanged(ARROWS, [offset("ITEM_FIELD_STACK_COUNT")]);
    store.flush();
    seam.tick(2);
    assert.equal(ammoSlot().count, "199");
    assert.deepEqual(failures(), [], "the spent arrow");

    // Picked up and dropped on the slot (OnClick/OnReceiveDrag → PickupInventoryItem(0)).
    const drop = boot.vm.execute(`
      PickupContainerItem(0, 1)
      __held = CursorHasItem() and true or false
      PickupInventoryItem(0)
      __heldAfter = CursorHasItem() and true or false
    `, "@ammo-slot:drop");
    assert.equal(drop.ok, true, drop.error);
    assert.equal(boot.vm.getGlobal("__held"), true);
    assert.equal(boot.vm.getGlobal("__heldAfter"), false, "the hand lets go");
    assert.deepEqual(setAmmoPackets(), ["208,9,0,0", "208,9,0,0"]);
    assert.deepEqual(failures(), [], "the drop");
  } finally {
    boot.close();
    await chain.close();
  }
});

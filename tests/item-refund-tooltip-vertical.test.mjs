// Plan item 2.10, the stock item tooltip's refund line (Wow.exe 0x006277f0): for a bag or worn item
// with a refund record, no blocking enchantment (0x00708ac0) and time left, the C tooltip adds a
// blank line and REFUND_TIME_REMAINING in 0x00ad2da8's colour (BGRA ff cc 00 → r 0, g 0.8, b 1),
// the time from 0x0061a9e0 in seconds rounded down — or «1 ч» + TIME_UNIT_DELIMITER + minutes for
// 3660-7199 s. An item with no record whose template carries ITEM_FLAG_ITEM_PURCHASE_RECORD is asked
// about (0x007089e0, once) and shows nothing yet. Real MPQ GameTooltip over the live seam.
import assert from "node:assert/strict";
import test from "node:test";

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { clientDirectory } = await import("../tools/paths.mjs");
const { openClientArchives } = await import("../tools/mpq.mjs");

let clientDir;
try {
  clientDir = clientDirectory();
} catch {
  clientDir = undefined;
}

const PLAYER = 0x10n;
const HEAD = 0x201n;
const SWORD = 0x202n;
const ASKED = 0x203n;
const offset = (name) => UPDATE_FIELDS[name].offset;

function worldFixture() {
  const sent = [];
  const world = new WorldClient({
    send(opcode, payload = new Uint8Array()) { sent.push([opcode, [...payload]]); },
    close() {},
  });
  const state = new WorldState();
  world.state = state;
  const object = (guid, typeId, entries) => ({
    guid, typeId, position: undefined, movementFlags: 0, updateFlags: 0, targetGuid: undefined,
    runSpeed: undefined, turnRate: undefined, motion: undefined, glide: undefined, transport: undefined,
    speeds: undefined, transportTime: undefined, fields: new Map(entries),
  });
  state.objects.set(PLAYER, object(PLAYER, 4, [
    [offset("UNIT_FIELD_BYTES_0"), 1 | (1 << 8)],
    [offset("UNIT_FIELD_LEVEL"), 80],
    [offset("UNIT_FIELD_HEALTH"), 400],
    [offset("UNIT_FIELD_MAXHEALTH"), 500],
    [offset("PLAYER_FIELD_INV_SLOT_HEAD"), Number(HEAD)], [offset("PLAYER_FIELD_INV_SLOT_HEAD") + 1, 0],
    [offset("PLAYER_FIELD_PACK_SLOT_1"), Number(SWORD)], [offset("PLAYER_FIELD_PACK_SLOT_1") + 1, 0],
    [offset("PLAYER_FIELD_PACK_SLOT_1") + 2, Number(ASKED)], [offset("PLAYER_FIELD_PACK_SLOT_1") + 3, 0],
  ]));
  for (const [guid, entry] of [[HEAD, 1001], [SWORD, 1002], [ASKED, 1002]]) {
    state.objects.set(guid, object(guid, 1, [[offset("OBJECT_FIELD_ENTRY"), entry]]));
  }
  state.selfGuid = PLAYER;
  const store = new WorldStore(state);
  const template = (entry, itemClass, subClass, name) => ({
    entry, found: true, name, quality: 4, itemClass, subClass, flags: 0x1000, inventoryType: 1, bonding: 1,
    stackable: 1, bagFamily: 0, spells: [], itemLevel: 200, requiredLevel: 80, containerSlots: 0,
    maxDurability: 0, pageText: 0, startQuest: 0,
    maxCount: 0, block: 0, damage: [{ min: 0, max: 0, type: 0 }], delay: 0, resistances: [0, 0, 0, 0, 0, 0, 0],
    stats: [], requiredSkill: 0, requiredSkillRank: 0, requiredReputationFaction: 0, requiredReputationRank: 0,
    allowableClass: 0, allowableRace: 0, sockets: [], socketBonus: 0, gemProperties: 0, description: "", sellPrice: 0,
  });
  world.itemTemplates.set(1001, template(1001, 4, 4, "Шлем гладиатора"));
  world.itemTemplates.set(1002, template(1002, 2, 7, "Меч гладиатора"));
  world.mapId = 0;
  world.selfName = "Флик";
  world.knownSpells = [{ id: 1, slot: 0 }];
  const realmTime = { minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  // Played 20 000 s; the helm bought at 19 000 (6200 s left), the sword at 16 000 (3200 s left).
  world.playedTime = { total: 20_000, atLevel: 100 };
  world.playedTimeReceivedAt = 1000;
  const record = (stamp) => ({ money: 0, honor: 1500, arena: 0, items: [], purchasedAtPlayed: stamp });
  world.itemRefunds.info.set(HEAD, record(19_000));
  world.itemRefunds.info.set(SWORD, record(16_000));
  return { world, store, sent };
}

test("the stock item tooltip's refund line and the hover request (0x006277f0)", {
  skip: clientDir ? false : "no 3.3.5a client on this machine",
}, async () => {
  const chain = await openClientArchives(clientDir);
  const decoder = new TextDecoder("utf-8");
  const { world, store, sent } = worldFixture();
  const previousWorld = game.world;
  game.world = world;
  const seam = new LiveWorldSeam({
    world: () => world,
    store: () => store,
    spell: (id) => ({ id, name: "Проверочное заклинание", rank: "", iconPath: "Interface\\Icons\\Spell_Test" }),
    monotonic: () => 1000,
    globalCooldownUntil: () => 0,
    castSpell: () => {},
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
  });
  const lua = (source, name) => {
    const result = boot.vm.execute(source, `@refund-tooltip:${name}`);
    assert.equal(result.ok, true, result.error);
  };
  const tail = (setter) => {
    lua(`
      GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")
      ${setter}
      local count = GameTooltip:NumLines()
      local last = _G["GameTooltipTextLeft" .. count]
      local before = _G["GameTooltipTextLeft" .. (count - 1)]
      local r, g, b = last:GetTextColor()
      __tail = before:GetText() .. "|" .. last:GetText() .. "|" .. string.format("%.2f,%.2f,%.2f", r, g, b)
      GameTooltip:Hide()
    `, "tail");
    return boot.vm.getGlobal("__tail");
  };
  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.errors, [], "vertical inventory has no handled Lua failures");
    const remaining = (time) => boot.vm.globalString("REFUND_TIME_REMAINING").replace("%s", time);
    assert.equal(tail(`GameTooltip:SetInventoryItem("player", 1)`),
      ` |${remaining("1 ч 43 мин")}|0.00,0.80,1.00`, "6200 s: 3660-7199 reads an hour and minutes");
    assert.equal(tail(`GameTooltip:SetBagItem(0, 1)`), ` |${remaining("53 мин")}|0.00,0.80,1.00`,
      "3200 s: whole minutes, rounded down");
    world.playedTime = { total: 23_150, atLevel: 100 };
    assert.equal(tail(`GameTooltip:SetBagItem(0, 1)`).split("|")[1], remaining("50 сек"));

    // No record, template flag 0x1000: asked once on hover, no line.
    const asks = () => sent.filter(([opcode]) => opcode === OPCODES.CMSG_ITEM_REFUND_INFO).length;
    lua(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE"); GameTooltip:SetBagItem(0, 2); __n = GameTooltip:NumLines(); GameTooltip:Hide()`, "ask");
    const lines = boot.vm.getGlobal("__n");
    assert.equal(asks(), 1);
    lua(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE"); GameTooltip:SetBagItem(0, 2); __n = GameTooltip:NumLines(); GameTooltip:Hide()`, "ask-again");
    assert.equal(asks(), 1, "asked once per item");
    assert.equal(boot.vm.getGlobal("__n"), lines);

    // An enchanted item shows no line (0x00708ac0); neither does one past its two hours.
    world.state.objects.get(HEAD).fields.set(offset("ITEM_FIELD_ENCHANTMENT_1_1"), 1897);
    const enchanted = tail(`GameTooltip:SetInventoryItem("player", 1)`);
    assert.ok(!enchanted.includes(remaining("").slice(0, 20)), enchanted);
    world.playedTime = { total: 40_000, atLevel: 100 };
    const expired = tail(`GameTooltip:SetBagItem(0, 1)`);
    assert.ok(!expired.includes(remaining("").slice(0, 20)), expired);
    assert.deepEqual(boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`), []);
  } finally {
    boot.close();
    await chain.close();
    game.world = previousWorld;
  }
});

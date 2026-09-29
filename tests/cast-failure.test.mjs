import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { globalString } from "../dist/code/generated/globalStrings.js";
import { parseCastFailure, spellFailureText } from "../dist/code/world/SpellProtocol.js";
import { formatGlobalString } from "../dist/code/world/GlobalStringFormat.js";
import { singleSubclass, worldNameSources } from "../dist/code/world/WorldNames.js";
import { castFailedPacket, settle, travelClient } from "./fixtures/world-packets.mjs";

// 1.27. `Spell::WriteCastResultInfo` (game/Spells/Spell.cpp:4161-4339) writes `u8 castCount,
// u32 spell, u8 result` and then a tail that depends on the result, every value a u32:
//   REQUIRES_SPELL_FOCUS (102) focus · REQUIRES_AREA (101) area · TOTEMS (131) 0-2 items ·
//   TOTEM_CATEGORY (130) 0-2 categories · EQUIPPED_ITEM_CLASS[_MAINHAND/_OFFHAND] (29-31) class,
//   subclass mask · TOO_MANY_OF_ITEM (129) 0-1 limit category · CUSTOM_ERROR (172) SpellCustomErrors ·
//   REAGENTS (100) first missing item · PREVENTED_BY_MECHANIC (147) mechanic · NEED_EXOTIC_AMMO (54)
//   subclass mask · NEED_MORE_ITEMS (55) item, count · MIN_SKILL (150) skill line, value ·
//   FISHING_TOO_LOW (181) skill level.
// SMSG_PET_CAST_FAILED is written by the same function (Spell.cpp:4385-4386). The texts are the
// stock SPELL_FAILED_* templates of the generated GlobalStrings (Lua escapes and all).
const R = {
  NEED_EXOTIC_AMMO: 54, NEED_MORE_ITEMS: 55, EQUIPPED_ITEM_CLASS: 29, EQUIPPED_ITEM_CLASS_OFFHAND: 31,
  DONT_REPORT: 27, ITEM_ALREADY_ENCHANTED: 42, REAGENTS: 100, REQUIRES_AREA: 101, REQUIRES_SPELL_FOCUS: 102,
  TOO_MANY_OF_ITEM: 129, TOTEM_CATEGORY: 130, TOTEMS: 131, PREVENTED_BY_MECHANIC: 147, MIN_SKILL: 150,
  CUSTOM_ERROR: 172, FISHING_TOO_LOW: 181, OUT_OF_RANGE: 97,
};
const ITEMS = new Map([[5175, "Тотем земли"], [5176, "Тотем огня"], [2770, "Медная руда"], [17020, "Чародейский порошок"]]);
const NAMES = {
  area: (id) => (id === 3905 ? "Зангартопь" : undefined),
  item: (id) => ITEMS.get(id),
  itemSubclass: (itemClass, mask) => (itemClass === 2 && mask === 1 << 7 ? "Одноручный меч" : undefined),
};

const failure = (result, tail = [], spellId = 133) =>
  parseCastFailure(castFailedPacket({ castCount: 7, spellId, result, tail }));

test("the tail is read by the result code, and only as far as that code writes", () => {
  assert.deepEqual(failure(R.REQUIRES_AREA, [3905]), { castCount: 7, spellId: 133, result: R.REQUIRES_AREA, extra: [3905] });
  // TOTEMS writes only the non-zero ones of its two: none, one or two words.
  assert.equal(failure(R.TOTEMS).extra, undefined);
  assert.deepEqual(failure(R.TOTEMS, [5175]).extra, [5175]);
  assert.deepEqual(failure(R.TOTEMS, [5175, 5176]).extra, [5175, 5176]);
  assert.deepEqual(failure(R.TOTEMS, [5175, 5176, 99]).extra, [5175, 5176], "never a third");
  assert.deepEqual(failure(R.EQUIPPED_ITEM_CLASS, [2, 1 << 7]).extra, [2, 1 << 7]);
  assert.deepEqual(failure(R.NEED_MORE_ITEMS, [2770, 5]).extra, [2770, 5]);
  assert.deepEqual(failure(R.MIN_SKILL, [186, 75]).extra, [186, 75]);
  assert.deepEqual(failure(R.FISHING_TOO_LOW, [100]).extra, [100]);
  assert.deepEqual(failure(R.CUSTOM_ERROR, [28]).extra, [28]);
  // TOO_MANY_OF_ITEM writes its limit category only when the item has one.
  assert.equal(failure(R.TOO_MANY_OF_ITEM).extra, undefined);
  // A result with no tail keeps nothing, whatever follows it.
  assert.deepEqual(failure(R.ITEM_ALREADY_ENCHANTED, [999]), { castCount: 7, spellId: 133, result: R.ITEM_ALREADY_ENCHANTED });
  // Three bytes and a result with its tail missing altogether: the short buffer is not an error.
  assert.doesNotThrow(() => failure(R.REAGENTS));
  assert.equal(failure(R.REAGENTS).extra, undefined);
  assert.deepEqual(failure(R.EQUIPPED_ITEM_CLASS, [2]).extra, [2], "as much of the tail as there is");
});

test("each tail fills its stock template, with names where there are names", () => {
  const text = (result, tail, names = NAMES) => spellFailureText(failure(result, tail), names);
  assert.equal(text(R.REQUIRES_AREA, [3905]), "Вы должны находиться в зоне \"Зангартопь\".");
  assert.equal(text(R.TOTEMS, [5175]), "Требуется Тотем земли");
  assert.equal(text(R.TOTEMS, [5175, 5176]), "Требуется Тотем земли, Тотем огня");
  assert.equal(text(R.EQUIPPED_ITEM_CLASS, [2, 1 << 7]), "Вы должны держать в руке Одноручный меч.");
  assert.equal(text(R.EQUIPPED_ITEM_CLASS_OFFHAND, [2, 1 << 7]), "Необходимо держать Одноручный меч во второй руке.");
  assert.equal(text(R.CUSTOM_ERROR, [28]), "Не достаточно здоровья!");
  assert.equal(text(R.REAGENTS, [17020]), "Не хватает компонента: Чародейский порошок.");
  // «Требуется: %2$s %1$d.» — the wire says item then count, the template prints them the other way.
  assert.equal(text(R.NEED_MORE_ITEMS, [2770, 5]), "Требуется: Медная руда 5.");
  assert.equal(text(R.MIN_SKILL, [186, 75]), "Ваших навыков недостаточно. Необходимо: навык (75).");
  assert.equal(text(R.FISHING_TOO_LOW, [100]), "Требуется уровень навыка рыбной ловли 100");
  assert.equal(text(R.TOO_MANY_OF_ITEM, []), globalString("SPELL_FAILED_TOO_MANY_OF_ITEM"));
  assert.equal(text(R.OUT_OF_RANGE, []), "Вне зоны действия.");
  assert.equal(text(R.DONT_REPORT, []), undefined, "the server asked for silence");
});

test("without a name the text says a word, never the id", () => {
  const text = (result, tail) => spellFailureText(failure(result, tail), {});
  const quiet = (result, tail) => {
    const said = text(result, tail);
    assert.equal(typeof said, "string");
    assert.doesNotMatch(said, /\d/, `${result}: ${said}`);
    assert.doesNotMatch(said, /%|\|3|\\/, `${result}: ${said}`);
    return said;
  };
  // No area: the stock sentence that needs none (and the core's usual zero id says as much).
  assert.equal(quiet(R.REQUIRES_AREA, [3905]), globalString("SPELL_FAILED_INCORRECT_AREA"));
  assert.equal(quiet(R.REQUIRES_AREA, [0]), globalString("SPELL_FAILED_INCORRECT_AREA"));
  assert.equal(quiet(R.EQUIPPED_ITEM_CLASS, [2, 1 << 7]), globalString("SPELL_FAILED_EQUIPPED_ITEM"));
  assert.equal(quiet(R.TOTEMS, [5175, 5176]), "Требуется предмет");
  assert.equal(quiet(R.TOTEMS, []), "Требуется предмет");
  assert.equal(quiet(R.REAGENTS, [17020]), "Не хватает компонента: предмет.");
  // The four tables no gateway route serves yet (1.27б): a neutral word. A spell focus is an anvil
  // or a fire, a totem category a hammer or a pick.
  assert.equal(quiet(R.REQUIRES_SPELL_FOCUS, [3]), "Требуется объект.");
  assert.equal(quiet(R.TOTEM_CATEGORY, [21]), "Требуется: инструмент.");
  assert.equal(quiet(R.PREVENTED_BY_MECHANIC, [12]), "Действие невозможно. Причина: эффект.");
  quiet(R.NEED_EXOTIC_AMMO, [8]);
  // Three custom errors live under a suffixed name in GlobalStrings.lua.
  assert.equal(quiet(R.CUSTOM_ERROR, [14]), globalString("SPELL_FAILED_CUSTOM_ERROR_14_NONE"));
  assert.equal(quiet(R.CUSTOM_ERROR, [63]), globalString("SPELL_FAILED_CUSTOM_ERROR_63_NONE"));
  assert.equal(quiet(R.CUSTOM_ERROR, [64]), globalString("SPELL_FAILED_CUSTOM_ERROR_64_NONE"));
  assert.notEqual(globalString("SPELL_FAILED_CUSTOM_ERROR_63_NONE"), globalString("SPELL_FAILED_UNKNOWN"));
  // An unknown or empty custom error is a general refusal, not its number.
  assert.equal(quiet(R.CUSTOM_ERROR, [68]), globalString("SPELL_FAILED_UNKNOWN"));
  assert.equal(quiet(R.CUSTOM_ERROR, [4000]), globalString("SPELL_FAILED_UNKNOWN"));
  assert.equal(quiet(R.CUSTOM_ERROR, []), globalString("SPELL_FAILED_UNKNOWN"));
  // A code the enum does not know still says which one it was (system-windows.test.mjs).
  assert.match(spellFailureText(250), /250/);
});

test("the browser's tables reach the refusal: a zone, and a weapon class by its one subclass bit", () => {
  // What EnterWorld.ts hands the world: AreaClient's names and ItemMetadataClient's
  // `/dbc/item-subclasses` words, which name one class and subclass rather than a mask.
  const asked = [];
  const sources = worldNameSources({
    area: (id) => (id === 3905 ? "Зангартопь" : undefined),
    itemSubclassName: (itemClass, subClass) => {
      asked.push([itemClass, subClass]);
      return itemClass === 2 && subClass === 15 ? "Кинжал" : itemClass === 4 && subClass === 31 ? "Верх" : undefined;
    },
  });
  const text = (result, tail) => spellFailureText(failure(result, tail), sources);
  assert.equal(text(R.REQUIRES_AREA, [3905]), "Вы должны находиться в зоне \"Зангартопь\".");
  assert.equal(text(R.REQUIRES_AREA, [12]), globalString("SPELL_FAILED_INCORRECT_AREA"), "a zone the table lacks");
  assert.equal(text(R.EQUIPPED_ITEM_CLASS, [2, 1 << 15]), "Вы должны держать в руке Кинжал.");
  assert.deepEqual(asked, [[2, 15]]);
  // A mask of several subclasses (any one-handed weapon) names none of them: the stock sentence
  // that needs no name, and no lookup at all.
  assert.equal(text(R.EQUIPPED_ITEM_CLASS, [2, (1 << 15) | (1 << 7)]), globalString("SPELL_FAILED_EQUIPPED_ITEM"));
  assert.equal(text(R.EQUIPPED_ITEM_CLASS, [2, 0]), globalString("SPELL_FAILED_EQUIPPED_ITEM"));
  assert.equal(asked.length, 1);
  // The mask is an unsigned word: its top bit is subclass 31, not a negative number.
  assert.equal(sources.itemSubclass(4, 0x8000_0000), "Верх");
  assert.equal(singleSubclass(0x8000_0000), 31);
  assert.equal(singleSubclass(1), 0);
  assert.equal(singleSubclass(0xffff_ffff), undefined);
  assert.equal(singleSubclass(0), undefined);
  // Without tables at all nothing is named, and nothing throws.
  const empty = worldNameSources({});
  assert.equal(empty.area(3905), undefined);
  assert.equal(empty.itemSubclass(2, 1 << 15), undefined);
});

test("the formatter reads the client's templates the way the client prints them", () => {
  assert.equal(formatGlobalString("Требуется: %2$s %1$d.", [5, "Медная руда"]), "Требуется: Медная руда 5.");
  assert.equal(formatGlobalString("%s и %s", ["а", "б"]), "а и б");
  assert.equal(formatGlobalString("Вы должны держать в руке |3-6(%s).", ["Щит"]), "Вы должны держать в руке Щит.");
  assert.equal(formatGlobalString("в зоне \\\"%s\\\".\\nдальше", ["Х"]), "в зоне \"Х\".\nдальше");
  assert.equal(formatGlobalString("100%% %d", [3.7]), "100% 3");
  const slots = (count) => formatGlobalString("%2$s (%1$d |4ячейка:ячейки:ячеек;)", [count, "Сумка"]);
  assert.deepEqual([1, 3, 5, 11, 21, 112, 104].map(slots), [
    "Сумка (1 ячейка)", "Сумка (3 ячейки)", "Сумка (5 ячеек)", "Сумка (11 ячеек)", "Сумка (21 ячейка)",
    "Сумка (112 ячеек)", "Сумка (104 ячейки)",
  ]);
  assert.equal(formatGlobalString("%d |4item:items;", [1]), "1 item");
  assert.equal(formatGlobalString("%d |4item:items;", [2]), "2 items");
  assert.equal(formatGlobalString("Требуется %s", []), "Требуется ", "a missing argument prints nothing, not %s");
});

test("the world prints the player's and the pet's refusals with their tails", async () => {
  const self = 0x1234n;
  const { client, connection } = await travelClient([], self);
  const statuses = [];
  const petMessages = [];
  client.onSpellStatus = (message, error) => statuses.push({ message, error });
  client.events.on("PET_MESSAGE", (message) => petMessages.push(message));
  client.worldNames = { area: (id) => (id === 3905 ? "Зангартопь" : undefined) };
  client.itemTemplates.set(17020, { entry: 17020, found: true, name: "Чародейский порошок" });
  try {
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 3, spellId: 41617, result: R.REQUIRES_AREA, tail: [3905] }));
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 4, spellId: 1459, result: R.REAGENTS, tail: [17020] }));
    // An uncached reagent: the word now, the query for the name on its way.
    connection.push(OPCODES.SMSG_CAST_FAILED, castFailedPacket({ castCount: 5, spellId: 1459, result: R.REAGENTS, tail: [17031] }));
    connection.push(OPCODES.SMSG_PET_CAST_FAILED, castFailedPacket({ spellId: 3110, result: R.OUT_OF_RANGE }));
    connection.push(OPCODES.SMSG_PET_CAST_FAILED, castFailedPacket({ spellId: 3110, result: R.DONT_REPORT }));
    // The pet's packet has the player's tail too (the same WriteCastResultInfo).
    connection.push(OPCODES.SMSG_PET_CAST_FAILED, castFailedPacket({ spellId: 3110, result: R.REQUIRES_AREA, tail: [3905] }));
    await settle();
    assert.deepEqual(statuses, [
      { message: "Вы должны находиться в зоне \"Зангартопь\".", error: true },
      { message: "Не хватает компонента: Чародейский порошок.", error: true },
      { message: "Не хватает компонента: предмет.", error: true },
    ]);
    assert.equal(connection.sentOf(OPCODES.CMSG_ITEM_QUERY_SINGLE).length, 1);
    assert.deepEqual(petMessages, [
      { text: "Питомец: Вне зоны действия.", error: true },
      { text: "Питомец: Вы должны находиться в зоне \"Зангартопь\".", error: true },
    ], "the stock words, no spell id or code, and nothing for DONT_REPORT");
  } finally {
    client.close();
  }
});

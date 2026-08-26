import assert from "node:assert/strict";
import test from "node:test";
import { parseItemQueryResponse, QUERY_MISSING_FLAG } from "../dist/code/world/QueryCacheProtocol.js";
import { fillTemplate, inventoryTypeName, itemTooltipContent, itemTooltipFor } from "../dist/code/browser/ui/ItemTooltip.js";
import {
  GLOBAL_STRING_DATA_AVAILABLE, GLOBAL_STRINGS, ITEM_MOD_NAMES,
} from "../dist/code/generated/globalStrings.js";
import { game } from "../dist/code/browser/game/Context.js";
import { clearSpellNames } from "../dist/code/browser/ui/SpellNames.js";

/**
 * The one item tooltip, checked against a real `SMSG_ITEM_QUERY_SINGLE_RESPONSE`.
 *
 * The packet is built here rather than mocked because the whole point of slice Л2 is that the
 * template was arriving and being thrown away: nine windows printed «Предмет N» while
 * `WorldClient.itemTemplates` held sixty fields for that entry. So every fixture goes through
 * `parseItemQueryResponse` first, and what the builder sees is exactly what the wire carries.
 *
 * The order of the lines is the reference client's (`wowee/src/ui/item_tooltip.cpp:219-604`) and
 * the words are the dataset's, so an assertion on a literal Russian sentence is an assertion about
 * `GlobalStrings.lua` as much as about this file.
 */

const encoder = new TextEncoder();

function bytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const u8 = (value) => Uint8Array.from([value & 0xff]);
const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const i32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
};
const f32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, true);
  return out;
};
const cstr = (value) => bytes(encoder.encode(value), u8(0));

/** `MAX_ITEM_PROTO_DAMAGES`, `MAX_SPELL_SCHOOL`, `MAX_ITEM_PROTO_SPELLS`, `MAX_ITEM_PROTO_SOCKETS`. */
const DAMAGES = 2;
const SCHOOLS = 7;
const SPELLS = 5;
const SOCKETS = 3;

/**
 * One item query answer, with every block at its fixed length.
 *
 * An empty spell slot is `0, 0, 0, -1, 0, -1` and not zeros — the trap the parser's own comment
 * names — so the padding here writes exactly what the core writes, or the "an empty slot gives no
 * line" test would be testing the fixture instead of the builder.
 */
function itemPacket(fields = {}) {
  const f = {
    entry: 6948, itemClass: 15, subClass: 0, name: "Камень возвращения", displayInfoId: 6418,
    quality: 1, flags: 0, flags2: 0, buyPrice: 0, sellPrice: 0, inventoryType: 0,
    allowableClass: 0xffff_ffff, allowableRace: 0xffff_ffff, itemLevel: 0, requiredLevel: 1,
    requiredSkill: 0, requiredSkillRank: 0, requiredReputationFaction: 0, requiredReputationRank: 0,
    maxCount: 1, stackable: 1, containerSlots: 0, stats: [], damage: [], resistances: [],
    delay: 0, spells: [], bonding: 1, description: "", startQuest: 0, itemSet: 0,
    maxDurability: 0, sockets: [], socketBonus: 0, ...fields,
  };
  const damage = Array.from({ length: DAMAGES }, (_, index) => {
    const one = f.damage[index] ?? [0, 0, 0];
    return bytes(f32(one[0]), f32(one[1]), u32(one[2]));
  });
  const resistances = Array.from({ length: SCHOOLS }, (_, index) => u32(f.resistances[index] ?? 0));
  const spells = Array.from({ length: SPELLS }, (_, index) => {
    const one = f.spells[index];
    return one
      ? bytes(i32(one[0]), u32(one[1]), i32(-Math.abs(one[2] ?? 0)), i32(one[3] ?? 0), u32(0), i32(-1))
      : bytes(u32(0), u32(0), u32(0), i32(-1), u32(0), i32(-1));
  });
  const sockets = Array.from({ length: SOCKETS }, (_, index) =>
    bytes(u32(f.sockets[index] ?? 0), u32(0)));
  return bytes(
    u32(f.entry),
    u32(f.itemClass), u32(f.subClass), i32(-1), cstr(f.name), u8(0), u8(0), u8(0),
    u32(f.displayInfoId), u32(f.quality), u32(f.flags), u32(f.flags2), i32(f.buyPrice),
    u32(f.sellPrice), u32(f.inventoryType), u32(f.allowableClass), u32(f.allowableRace),
    u32(f.itemLevel), u32(f.requiredLevel), u32(f.requiredSkill), u32(f.requiredSkillRank),
    u32(0), u32(0), u32(0), u32(f.requiredReputationFaction), u32(f.requiredReputationRank),
    i32(f.maxCount), i32(f.stackable), u32(f.containerSlots),
    u32(f.stats.length), ...f.stats.flatMap(([type, value]) => [u32(type), i32(value)]),
    u32(0), u32(0),
    ...damage,
    ...resistances,
    u32(f.delay), u32(0), f32(0),
    ...spells,
    u32(f.bonding), cstr(f.description), u32(0), u32(0), u32(0), u32(f.startQuest), u32(0),
    i32(0), u32(0), i32(0), i32(0),
    u32(0), u32(f.itemSet), u32(f.maxDurability), u32(0), u32(0), u32(0), u32(0),
    ...sockets,
    u32(f.socketBonus), u32(0), u32(0), f32(0), u32(0), u32(0), u32(0),
  );
}

const template = (fields) => parseItemQueryResponse(itemPacket(fields));
const texts = (content) => content.lines.map((line) => line.text);
const toneOf = (content, prefix) => content.lines.find((line) => line.text.startsWith(prefix))?.tone;
const withGlobalStrings = {
  skip: GLOBAL_STRING_DATA_AVAILABLE ? false : "no locally generated GlobalStrings data",
};
const withNeutralGlobalStrings = {
  skip: GLOBAL_STRING_DATA_AVAILABLE ? "neutral GlobalStrings fixture is not active" : false,
};

// The exact words remain covered above when the user has generated their local client-data slice.
// A clean checkout still exercises the decisions around those words with deliberately synthetic
// templates, instead of turning every tooltip assertion into a data-dependent skip.
if (!GLOBAL_STRING_DATA_AVAILABLE) {
  Object.assign(GLOBAL_STRINGS, {
    INVTYPE_AMMO: "fixture ammo",
    INVTYPE_WEAPONOFFHAND: "fixture offhand",
    INVTYPE_SHIELD: "fixture shield",
    DAMAGE_TEMPLATE: "fixture damage %d-%d",
    SPEED: "fixture speed",
    DPS_TEMPLATE: "fixture dps %.1f",
    ARMOR_TEMPLATE: "fixture armor %d",
    ITEM_MIN_LEVEL: "fixture level %d",
    DURABILITY_TEMPLATE: "fixture durability %d/%d",
    ITEM_CLASSES_ALLOWED: "fixture classes %s",
    ITEM_RACES_ALLOWED: "fixture races %s",
    ITEM_SPELL_TRIGGER_ONUSE: "fixture use",
    ITEM_SPELL_TRIGGER_ONEQUIP: "fixture equip",
    ITEM_SPELL_TRIGGER_ONPROC: "fixture proc",
  });
}

/** The sword the order test is written against: a rare one-hander with three stats and a proc. */
function sword() {
  return template({
    entry: 19019, name: "Громовая Ярость, благословенный клинок искателя ветра", itemClass: 2,
    subClass: 7, quality: 5, inventoryType: 13, itemLevel: 80, requiredLevel: 60,
    flags: 0x0000_0008, maxCount: 0, bonding: 1, allowableClass: 0xffff_ffff,
    damage: [[44, 179, 0]], delay: 1900, resistances: [0, 0, 0, 0, 0, 0, 0],
    stats: [[4, 5], [3, 6], [7, 8], [31, 12]],
    spells: [[21992, 2, 0, 0]],
    maxDurability: 125, description: "Быстрее, чем молния", sellPrice: 133_057,
  });
}

test("a weapon's lines come out in the reference client's order", withGlobalStrings, () => {
  const content = itemTooltipContent({ entry: 19019, template: sword() },
    { playerLevel: 70, spellName: () => "Гнев Пронзающего Ветра" });
  assert.deepEqual(texts(content), [
    "Уровень предмета: 80",
    "Героический",
    "Становится персональным при получении",
    "Одноручное",
    "Урон: 44 - 179  Скорость 1.90",
    "(58.7 ед. урона в секунду)",
    "+5 к силе  +6 к ловкости  +8 к выносливости",
    "Рейтинг меткости +12.",
    "Требуется уровень: 60",
    "Прочность: 125 / 125",
    "Возможный эффект при попадании: Гнев Пронзающего Ветра",
    "«Быстрее, чем молния»",
    "Цена продажи: 13з 30с 57м",
  ]);
  assert.equal(content.title, "Громовая Ярость, благословенный клинок искателя ветра");
  assert.equal(content.quality, 5, "the title's colour, which is why there is no quality *line*");
  // Three of the thirteen carry a tone; the rest are the tooltip's ordinary colour.
  assert.equal(toneOf(content, "+5 к силе"), "stat");
  assert.equal(toneOf(content, "Возможный эффект"), "spell");
  assert.equal(toneOf(content, "«Быстрее"), "flavour");
});

test("armour is resistance zero, and the other six are named schools", withGlobalStrings, () => {
  // There is no armour field in 3.3.5: `ItemTemplate.cpp:250` writes Armor into
  // `Resistance[SPELL_SCHOOL_NORMAL]`, and the dataset agrees — `RESISTANCE0_NAME` is «к броне».
  const content = itemTooltipContent({
    entry: 16963,
    template: template({
      entry: 16963, name: "Наплечники Хранителя Могил", itemClass: 4, subClass: 4,
      quality: 4, inventoryType: 3, itemLevel: 76, requiredLevel: 60,
      resistances: [1_005, 0, 25, 0, 30, 0, 0], stats: [[7, 22], [5, 18]],
    }),
  }, { playerLevel: 60 });
  const lines = texts(content);
  assert.ok(lines.includes("Броня: 1005"), `armour line missing from ${JSON.stringify(lines)}`);
  assert.ok(lines.includes("+25 Сопротивление огню"));
  assert.ok(lines.includes("+30 Сопротивление магии льда"));
  assert.equal(lines.filter((line) => line.startsWith("+") && line.includes("Сопротивление")).length, 2,
    "a resistance of zero gives no line, and school zero is never one of the six");
  // Armour comes before the stats and after the slot, as it does in the original.
  assert.ok(lines.indexOf("Броня: 1005") < lines.indexOf("+22 к выносливости  +18 к интеллекту"));
  assert.ok(lines.indexOf("Плечо") < lines.indexOf("Броня: 1005"));
});

test("an empty spell slot is not a spell, and a trigger with no word is not a line", withGlobalStrings, () => {
  // The core writes `0, 0, 0, -1, 0, -1` into an unused slot, so four of the five slots on a
  // hearthstone are neither zero nor a spell.
  const one = itemTooltipContent({ entry: 6948, template: template({ spells: [[8690, 0, 0, 3_600_000]] }) },
    { spellName: () => "Возвращение" });
  const used = texts(one).filter((line) => line.startsWith("Использование:"));
  assert.deepEqual(used, ["Использование: Возвращение"], "five slots, one spell, one line");

  // Trigger 3 is not in the client's table and the reference gives it no word either
  // (`wowee/include/game/item_text.hpp:32-41`), so the line is dropped rather than titled blank.
  const unnamed = itemTooltipContent({ entry: 6948, template: template({ spells: [[8690, 3, 0, 0]] }) },
    { spellName: () => "Возвращение" });
  assert.equal(texts(unnamed).some((line) => line.includes("Возвращение")), false);

  // A spell whose name has not arrived still says which spell it is rather than nothing at all.
  const nameless = itemTooltipContent({ entry: 6948, template: template({ spells: [[8690, 1, 0, 0]] }) });
  assert.ok(texts(nameless).includes("Если на персонаже: Заклинание 8690"));
});

test("a level the character has not reached is red, and one it has is not", withGlobalStrings, () => {
  const item = sword();
  const low = itemTooltipContent({ entry: 19019, template: item }, { playerLevel: 42 });
  assert.equal(toneOf(low, "Требуется уровень"), "unmet");
  const high = itemTooltipContent({ entry: 19019, template: item }, { playerLevel: 60 });
  assert.equal(toneOf(high, "Требуется уровень"), "muted");
  // Without a character there is nothing to fail, so the line is shown plainly rather than red.
  const noone = itemTooltipContent({ entry: 19019, template: item });
  assert.equal(toneOf(noone, "Требуется уровень"), "muted");
  // Level 1 is every item's floor and the original prints nothing for it.
  const anyone = itemTooltipContent({ entry: 6948, template: template({ requiredLevel: 1 }) }, { playerLevel: 5 });
  assert.equal(texts(anyone).some((line) => line.startsWith("Требуется уровень")), false);
});

test("«any class» is a mask of ones, not a restriction", withGlobalStrings, () => {
  // `allowableClass` is unsigned on the wire: the core stores −1 for an unrestricted item, so a
  // reader that took it signed would make every item in the game look class-locked.
  const free = itemTooltipContent({ entry: 6948, template: template({ allowableClass: 0xffff_ffff, allowableRace: 0xffff_ffff }) });
  assert.equal(texts(free).some((line) => line.startsWith("Классы:")), false);
  assert.equal(texts(free).some((line) => line.startsWith("Расы:")), false);

  const zero = itemTooltipContent({ entry: 6948, template: template({ allowableClass: 0, allowableRace: 0 }) });
  assert.equal(texts(zero).some((line) => line.startsWith("Классы:")), false, "zero means anyone too");

  // Bit n is class n + 1: warrior is 1, paladin 2, hunter 3.
  const plate = itemTooltipContent({ entry: 6948, template: template({ allowableClass: 0b11, allowableRace: 0b10 }) });
  assert.ok(texts(plate).includes("Классы: Воин, Паладин"));
  assert.ok(texts(plate).includes("Расы: Орк"));
});

test("Л2 a mask never names a class or a race this build does not have", withGlobalStrings, () => {
  // −1 is not the only way the dump spells «anyone», and walking all 32 bits of the other ways
  // invented names. Measured over all 38,607 `item_template` rows of
  // `TDB_full_world_335.24081_2024_08_17.sql` put through the built builder: 4,406 rows printed a
  // «Класс N» and 4,732 a «Раса N» — every mount and every fish among them. There is no class 10
  // and no race 9 in 3.3.5, and the reference walks its own list of the real ten and stops
  // (`wowee/src/ui/item_tooltip.cpp:63-78` and `:80-97`).
  const line = (mask, prefix) => texts(itemTooltipContent({
    entry: 787, template: template({ allowableClass: mask, allowableRace: mask }),
  })).find((text) => text.startsWith(prefix));
  const classes = (mask) => line(mask, "Классы:");
  const races = (mask) => line(mask, "Расы:");

  // 787 «Slitherskin Mackerel»: fifteen bits, ten real classes. The reference counts the real ones
  // and leaves at ten (`item_tooltip.cpp:67`), so an item everyone may use gets no line.
  assert.equal(classes(32_767), undefined);
  assert.equal(races(32_767), undefined);
  // 8563 «Red Mechanostrider» spells it with eighteen bits, 9391 «The Shoveler» with thirty-one.
  assert.equal(classes(262_143), undefined);
  assert.equal(classes(2_147_483_647), undefined);
  assert.equal(races(2_147_483_647), undefined);
  // 1535 covers all ten classes without covering class 10's absent bit; 335 rows of the dump write
  // it, and every one of them had been printing the full list of ten where the reference prints
  // nothing at all.
  assert.equal(classes(1_535), undefined);

  // A real restriction still reads, and reads without holes: 1101 is the alliance side of
  // «Red Mechanostrider» — races 1, 3, 4, 7 and 11 — and bit 8, race 9, is not in 3.3.5.
  assert.equal(races(1_101), "Расы: Человек, Дворф, Ночной эльф, Гном, Дреней");
  assert.equal(classes(1_025), "Классы: Воин, Друид", "1024 is druid, class 11, not class 10");
  // A mask whose only bits are ones this build has no class for says nothing rather than making
  // one up: bit 9 is the missing class 10 and bit 11 the missing class 12.
  assert.equal(classes(0b1010_0000_0000), undefined);
});

test("Л2 ammunition has no swing, so it gets no damage line", withGlobalStrings, () => {
  // 2512 «Грубая стрела»: class 6, `INVTYPE_AMMO`, damage 1–2 and `delay` 3000 — a leftover, not a
  // swing timer. The pair «has damage, has a delay» was the test, and it printed «Урон: 1 - 2
  // Скорость 3.00» and a DPS line on every arrow and bullet in the game. Measured over the dump:
  // 4,395 rows carry both, and 55 of them are worn in no weapon slot — 53 ammunition, plus 4959
  // «Throwing Tomahawk» (slot 0) and 1700 «Admin Warlord's Claymore» (slot 2). The reference
  // closes the block by slot (`wowee/include/game/inventory.hpp:71-84`).
  const arrow = texts(itemTooltipContent({
    entry: 2512,
    template: template({ entry: 2512, name: "Грубая стрела", itemClass: 6, subClass: 2,
      inventoryType: 24, itemLevel: 5, damage: [[1, 2, 0]], delay: 3_000, stackable: 1_000 }),
  }));
  assert.equal(arrow.some((line) => line.startsWith("Урон:")), false, arrow.join(" | "));
  assert.equal(arrow.some((line) => line.includes("ед. урона в секунду")), false);
  assert.ok(arrow.includes("Боеприпасы"), "it still says what it is");

  // An off-hand weapon keeps its damage: all 159 rows of the dump worn in slot 22 with a damage
  // range are `itemClass` 2, and the original prints their damage. The reference's own predicate
  // omits 22, because it exists to decide whether two items may be compared side by side.
  const offhand = texts(itemTooltipContent({
    entry: 12939,
    template: template({ entry: 12939, name: "Племенной защитник Дал'Ренда", itemClass: 2,
      subClass: 7, inventoryType: 22, damage: [[52, 97, 0]], delay: 1_800 }),
  }));
  assert.ok(offhand.includes("Урон: 52 - 97  Скорость 1.80"), offhand.join(" | "));
  assert.ok(offhand.includes("(41.4 ед. урона в секунду)"));

  // A shield is the other half of the reference's reasoning: it is held in a hand and has no
  // damage to compare, so slot 14 is not on the list and its armour line stands alone.
  const shield = texts(itemTooltipContent({
    entry: 22801, template: template({ entry: 22801, itemClass: 4, subClass: 6, inventoryType: 14,
      resistances: [4_000, 0, 0, 0, 0, 0, 0], delay: 2_000 }),
  }));
  assert.equal(shield.some((line) => line.startsWith("Урон:")), false);
  assert.ok(shield.includes("Броня: 4000"));
});

test("Л2 an item's spell is asked for, because nothing else in the client asks for it", withGlobalStrings, async () => {
  // `game.spells` is filled by the spellbook (what the character knows), the aura strip (what is
  // on a unit) and `ensureSpellNames` (casts, the command bar, the talent trees). An item's spell
  // is in none of the three, so reading the map without ordering the row printed «Использование:
  // Заклинание 8690» on the Hearthstone and left it there for the session. 15,811 of the dump's
  // 38,607 rows carry at least one such line, over 7,587 distinct spells.
  clearSpellNames();
  game.spells.clear();
  const hearthstone = template({ spells: [[8690, 0, 0, 3_600_000], [439, 3, 0, 0]] });
  const asked = [];
  game.world = { state: { selfGuid: undefined, objects: new Map() }, itemTemplate: () => hearthstone };
  game.spellMetadataClient = {
    load: async (ids) => {
      asked.push([...ids]);
      return new Map(ids.map((id) => [id, { name: "Возвращение", rank: "" }]));
    },
  };
  try {
    const first = texts(itemTooltipFor(6948));
    assert.ok(first.includes("Использование: Заклинание 8690"), "the placeholder is what it was");

    // One microtask to close the batch, one turn of the loop for the request to answer.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.deepEqual(asked, [[8690]],
      "trigger 3 has no opening word and so no line, and a row nobody prints is a row nobody asks for");

    const second = texts(itemTooltipFor(6948));
    assert.ok(second.includes("Использование: Возвращение"), second.join(" | "));
  } finally {
    game.world = undefined;
    game.spellMetadataClient = undefined;
    game.spells.clear();
    clearSpellNames();
  }
});

test("Л2 an item's spell keeps its rank, the way a cast bar does", withGlobalStrings, async () => {
  clearSpellNames();
  game.spells.clear();
  game.spells.set(43_185, { name: "Рунное лечебное зелье", rank: "Ранг 1" });
  game.world = {
    state: { selfGuid: undefined, objects: new Map() },
    itemTemplate: () => template({ entry: 33_447, spells: [[43_185, 0, 0, 60_000]] }),
  };
  try {
    // `spellName` from `SpellNames.ts` joins the name and the rank; `game.spells.get(id)?.name`
    // dropped the rank, which is the half that tells two rows of a chain apart.
    assert.ok(texts(itemTooltipFor(33_447)).includes("Использование: Рунное лечебное зелье Ранг 1"));
  } finally {
    game.world = undefined;
    game.spells.clear();
    clearSpellNames();
  }
});

test("Л2 a negative rating reads as a minus, not as «+-»", withGlobalStrings, () => {
  const stat = (type, value) => texts(itemTooltipContent({
    entry: 6948, template: template({ stats: [[type, value]] }),
  })).find((line) => !line.startsWith("Уникальный") && !line.startsWith("Становится"));

  // 25 of the 43 long templates write the plus themselves — «Рейтинг меткости +%d.» — and a
  // negative value read «Рейтинг меткости +-12.». Seven ask for the sign with `%c` and eleven ask
  // for neither. The reference reaches the same place with `%+d` (`item_tooltip.cpp:346`).
  assert.equal(stat(31, 12), "Рейтинг меткости +12.");
  assert.equal(stat(31, -12), "Рейтинг меткости -12.");
  assert.equal(stat(35, -8), "Рейтинг устойчивости -8.");
  // `%c` is the seven primaries' long form, and it was already right; it stays right.
  assert.equal(stat(7, -5), "-5 к выносливости");
  assert.equal(stat(7, 5), "+5 к выносливости");
  // A sentence that asks for no sign takes the number as it comes, the way the dataset wrote it.
  assert.equal(stat(38, -12), "Увеличивает силу атаки на -12.");
  assert.equal(stat(38, 12), "Увеличивает силу атаки на 12.");
  // Unreachable from the shipped TDB — all 21 negative `stat_value`s in it are on types 3 to 7,
  // which go the short way through the five-primary line — and reachable from a module's row.
  assert.equal(stat(99, -3), "-3 к характеристике 99");
});

test("neutral tooltip templates still exercise weapon-slot and armour decisions", withNeutralGlobalStrings, () => {
  const lines = (fields) => texts(itemTooltipContent({ entry: 1, template: template(fields) }));

  const ammo = lines({ itemClass: 6, inventoryType: 24, damage: [[1, 2, 0]], delay: 3_000 });
  assert.ok(ammo.includes("fixture ammo"));
  assert.equal(ammo.some((line) => line.startsWith("fixture damage")), false,
    "ammunition carries damage numbers but has no weapon swing");

  const offhand = lines({ itemClass: 2, inventoryType: 22, damage: [[52, 97, 0]], delay: 1_800 });
  assert.ok(offhand.includes("fixture damage 52-97  fixture speed 1.80"));
  assert.ok(offhand.includes("fixture dps 41.4"));

  const shield = lines({ itemClass: 4, inventoryType: 14, resistances: [4_000] });
  assert.ok(shield.includes("fixture armor 4000"));
  assert.equal(shield.some((line) => line.startsWith("fixture damage")), false);
});

test("neutral tooltip templates keep requirements and durability algorithmic", withNeutralGlobalStrings, () => {
  const item = template({ requiredLevel: 60, maxDurability: 125 });
  const low = itemTooltipContent({ entry: 1, template: item }, { playerLevel: 42, durability: 0 });
  assert.equal(toneOf(low, "fixture level"), "unmet");
  assert.ok(texts(low).includes("fixture durability 0/125"), "zero durability is a real reading");

  const high = itemTooltipContent({ entry: 1, template: item }, { playerLevel: 60, durability: 3 });
  assert.equal(toneOf(high, "fixture level"), "muted");
  assert.ok(texts(high).includes("fixture durability 3/125"));
});

test("neutral tooltip templates exercise masks and spell-slot filtering", withNeutralGlobalStrings, () => {
  const restricted = texts(itemTooltipContent({
    entry: 1,
    template: template({ allowableClass: 0b11, allowableRace: 0b10 }),
  }));
  assert.equal(restricted.filter((line) => line.startsWith("fixture classes ")).length, 1);
  assert.equal(restricted.filter((line) => line.startsWith("fixture races ")).length, 1);

  const unrestricted = texts(itemTooltipContent({
    entry: 1,
    template: template({ allowableClass: 0xffff_ffff, allowableRace: 0xffff_ffff }),
  }));
  assert.equal(unrestricted.some((line) => line.startsWith("fixture classes ")), false);
  assert.equal(unrestricted.some((line) => line.startsWith("fixture races ")), false);

  const spells = texts(itemTooltipContent({
    entry: 1,
    template: template({ spells: [[10, 0, 0, 0], [20, 3, 0, 0]] }),
  }, { spellName: (id) => `fixture spell ${id}` }));
  assert.deepEqual(spells.filter((line) => line.startsWith("fixture use")), ["fixture use fixture spell 10"]);
  assert.equal(spells.some((line) => line.includes("fixture spell 20")), false,
    "a trigger without a label is not a tooltip line");
});

test("an item nobody has heard of says so instead of showing a number as a name", () => {
  const unknown = itemTooltipContent({ entry: 123_123 });
  assert.equal(unknown.title, "Предмет 123123");
  assert.deepEqual(unknown.lines, [], "nothing is known, so nothing is claimed");
  assert.deepEqual(unknown.footer, ["Описание загружается…"]);

  // A row the server answered with the missing bit set is not a row that is on its way.
  const missing = parseItemQueryResponse(u32((123_123 | QUERY_MISSING_FLAG) >>> 0));
  const refused = itemTooltipContent({ entry: 123_123, template: missing }, { footer: ["Нажмите для действий"] });
  assert.equal(refused.title, "Предмет 123123");
  assert.deepEqual(refused.footer, ["Сервер не знает такого предмета", "Нажмите для действий"]);

  // The dump's row alone is a name and a slot, and the tooltip still says the rest is coming.
  const half = itemTooltipContent({
    entry: 4306,
    metadata: { entry: 4306, name: "Шёлковая ткань", displayId: 0, quality: 1, inventoryType: 0, stackable: 20, iconId: 0 },
  });
  assert.equal(half.title, "Шёлковая ткань");
  assert.deepEqual(texts(half), ["В стопке до 20"]);
  assert.deepEqual(half.footer, ["Описание загружается…"]);
});

test("a container counts its slots, and the count decides the Russian ending", withGlobalStrings, () => {
  // `CONTAINER_SLOTS` is «%2$s (%1$d |4ячейка:ячейки:ячеек;)» — a reordered argument and a plural
  // in one string, and both are the dataset's rather than this client's.
  const bag = (containerSlots) => texts(itemTooltipContent({
    entry: 14156,
    template: template({ itemClass: 1, subClass: 0, inventoryType: 18, containerSlots }),
  }));
  assert.ok(bag(20).includes("Сумка (20 ячеек)"));
  assert.ok(bag(1).includes("Сумка (1 ячейка)"));
  assert.ok(bag(2).includes("Сумка (2 ячейки)"));
  assert.ok(bag(14).includes("Сумка (14 ячеек)"), "eleven to fourteen take the last form");
  assert.ok(bag(22).includes("Сумка (22 ячейки)"));
  // A quiver is class 11 and counts its slots the same way; anything else shows what it is worn as.
  assert.ok(texts(itemTooltipContent({ entry: 2101, template: template({ itemClass: 11, inventoryType: 27, containerSlots: 12 }) }))
    .includes("Колчан (12 ячеек)"));
  assert.ok(bag(0).includes("Сумка"), "a container with no slots is still a bag");
});

test("the words for a slot, a stat and a socket are the dataset's own", withGlobalStrings, () => {
  // The rewritten builder dropped a hand-written table of 28 Russian slot names; these are the
  // client's own strings for the same numbers, and three of the names differ from the core's enum.
  assert.equal(inventoryTypeName(1), "Голова");
  assert.equal(inventoryTypeName(3), "Плечо", "the core calls this one SHOULDERS and the client SHOULDER");
  assert.equal(inventoryTypeName(9), "Запястья", "core WRISTS, client WRIST");
  assert.equal(inventoryTypeName(10), "Кисти рук", "core HANDS, client HAND");
  assert.equal(inventoryTypeName(17), "Двуручное");
  assert.equal(inventoryTypeName(0), undefined, "13,230 of the dump's 38,609 rows are worn as nothing");
  assert.equal(inventoryTypeName(99), undefined);

  // `ItemModType` has holes — 2 and 8 to 11 do not exist and 40 is not in 3.3 — so the stat names
  // are joined by number rather than indexed, and the generator reads the enum out of the core.
  assert.equal(ITEM_MOD_NAMES[4], "STRENGTH");
  assert.equal(ITEM_MOD_NAMES[2], undefined);
  assert.equal(ITEM_MOD_NAMES[40], undefined, "commented out in ItemTemplate.h: not in 3.3");
  assert.equal(GLOBAL_STRINGS["ITEM_MOD_STRENGTH_SHORT"], "к силе");
  assert.equal(GLOBAL_STRINGS["RESISTANCE0_NAME"], "к броне", "armour rides school zero");
  assert.equal(GLOBAL_STRINGS["EMPTY_SOCKET_RED"], "красное гнездо");

  const gemmed = texts(itemTooltipContent({ entry: 40342, template: template({ sockets: [2, 4, 0], socketBonus: 3_312 }) }));
  assert.deepEqual(gemmed.filter((line) => line.endsWith("гнездо")), ["красное гнездо", "желтое гнездо"]);

  // A stat this build has no name for prints its number rather than disappearing.
  const odd = texts(itemTooltipContent({ entry: 6948, template: template({ stats: [[2, 9]] }) }));
  assert.ok(odd.includes("+9 к характеристике 2"));
});

test("a template fills its own placeholders, in whatever order the translation wants", () => {
  assert.equal(fillTemplate("Броня: %d", 1_005), "Броня: 1005");
  assert.equal(fillTemplate("(%.1f ед. урона в секунду)", 58.684), "(58.7 ед. урона в секунду)");
  assert.equal(fillTemplate("Прочность: %d / %d", 40, 125), "Прочность: 40 / 125");
  assert.equal(fillTemplate("%2$s (%1$d)", 7, "Сумка"), "Сумка (7)");
  assert.equal(fillTemplate("Требуется: %s (%d)", "Кузнечное дело", 300), "Требуется: Кузнечное дело (300)");
  // A placeholder with no argument is left standing rather than turned into «undefined».
  assert.equal(fillTemplate("Броня: %d"), "Броня: %d");
});

test("the two sources stay two: the dump's row never becomes the template", withGlobalStrings, () => {
  // `ItemMetadata` is a gateway type validated by `isItemMetadata`, and `src/gateway` may not
  // depend on `src/world` — so the builder takes both and merges neither. The wire wins on the
  // fields both carry, because the query is answered from `item_template` at run time.
  const metadata = { entry: 19019, name: "Старое имя", displayId: 30_606, quality: 1, inventoryType: 0, stackable: 1, iconId: 0 };
  const content = itemTooltipContent({ entry: 19019, metadata, template: sword() }, { playerLevel: 70 });
  assert.equal(content.title, "Громовая Ярость, благословенный клинок искателя ветра");
  assert.equal(content.quality, 5);
  assert.ok(texts(content).includes("Одноручное"), "the slot comes from the template, not from the dump's zero");
});

test("what only the slot knows: the stack in hand and the wear on the item", withGlobalStrings, () => {
  const worn = itemTooltipContent({ entry: 19019, template: sword() }, { playerLevel: 70, durability: 3 });
  assert.ok(texts(worn).includes("Прочность: 3 / 125"));
  // Zero is a broken item, not a missing reading, so it must not fall back to the maximum.
  const broken = itemTooltipContent({ entry: 19019, template: sword() }, { playerLevel: 70, durability: 0 });
  assert.ok(texts(broken).includes("Прочность: 0 / 125"));

  const stack = itemTooltipContent({ entry: 4306, template: template({ entry: 4306, name: "Шёлковая ткань", stackable: 20 }) },
    { count: 12 });
  const lines = texts(stack);
  assert.ok(lines.includes("В стопке до 20"));
  assert.ok(lines.includes("Количество: 12"));
  assert.equal(texts(itemTooltipContent({ entry: 4306, template: template({ stackable: 20 }) }, { count: 1 }))
    .some((line) => line.startsWith("Количество")), false, "one of a thing is not a stack");
});

import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SpellMetadataClient, spellButtonUsable } from "../dist/code/browser/SpellMetadata.js";
import { SPELL_REQUIRED_TARGET_MASK, SPELL_REQUIRED_TARGET_MODE, spellRequiredTargeting } from "../dist/code/gateway/SpellMetadata.js";
import { parseSpellShapeshiftFormBonuses } from "../dist/code/gateway/SpellShapeshiftForms.js";

// Merged 2026-10-20 from 5 files; each block below is one former file,
// kept in its own scope so its helpers and module loads stay as they were.

// ── spell-metadata.test.mjs
{
test("a spell placeholder stays disabled until metadata arrives", () => {
  assert.equal(spellButtonUsable(undefined), false);
  assert.equal(spellButtonUsable({ passive: true }), false);
  assert.equal(spellButtonUsable({ passive: false }), true);
});

/** v=11 retains auto-repeat/recipe metadata and adds bounded target-selection metadata. */
const fireball = {
  id: 133, name: "Огненный шар", rank: "Уровень 1", description: "", iconId: 7, iconPath: "",
  targetingContractVersion: 1, requiredTargetMask: 0, requiredTargetMode: 0,
  passive: false, powerType: 0, powerCost: 0, powerCostPercent: 8, recoveryTime: 0,
  categoryRecoveryTime: 0, startRecoveryTime: 1500, cooldownStartedOnEvent: false,
  effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], effectBasePoints: [13, 0, 0],
  effectDieSides: [9, 0, 0], effectPeriod: [0, 0, 0], duration: 0, procChance: 100,
  spellLevel: 1, spellClassSet: 3, spellClassMask: [1, 0, 0], schoolMask: 4,
  rangeMin: 0, rangeMax: 35, rangeFlags: 0, castTime: 1500, autoRepeat: false,
  displayInStanceBar: false, stanceBarOrder: 0,
};

async function loadOne(payload) {
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/auth");
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /&v=20$/, // 13.10: v=20; 3.39: v=19 (12.10: v=18; L13: v=17)
      "the marker expires cached responses before the stock tooltip fields while retaining earlier fixes");
    return { ok: true, json: async () => payload };
  };
  try {
    return await client.load([133]);
  } finally {
    globalThis.fetch = previous;
  }
}

test("К1 the guard refuses a record from before the rank key existed", async () => {
  assert.equal((await loadOne([fireball])).get(133).spellClassMask.length, 3);

  // The response cache is an hour long, so a browser can be handed the previous shape by its own
  // disk after the gateway has moved on. `rankChainKey` joins `spellClassMask`, and joining
  // `undefined` throws in the middle of a repaint rather than drawing a wrong book.
  const { spellClassMask, ...withoutMask } = fireball;
  await assert.rejects(loadOne([withoutMask]), /invalid data/);
  const { powerCostPercent, ...withoutPercent } = fireball;
  await assert.rejects(loadOne([withoutPercent]), /invalid data/);
  const { spellLevel, ...withoutLevel } = fireball;
  await assert.rejects(loadOne([withoutLevel]), /invalid data/);
  const { autoRepeat, ...withoutAutoRepeat } = fireball;
  await assert.rejects(loadOne([withoutAutoRepeat]), /invalid data/);
  const { displayInStanceBar, ...withoutStances } = fireball;
  await assert.rejects(loadOne([withoutStances]), /invalid data/);
  await assert.rejects(loadOne([{ ...fireball, stanceBarOrder: 1.5 }]), /invalid data/);
  // 11.10: -1 is Spell.dbc's own value on 66 stock rows (14185 «Подготовка», 16511 «Кровоизлияние»,
  // 483 «Изучение»…). Refused, it took the whole batch with it: a rogue's talent tree had no icons.
  assert.equal((await loadOne([{ ...fireball, stanceBarOrder: -1 }])).get(133)?.stanceBarOrder, -1);
  await assert.rejects(loadOne([{ ...fireball, bonusActionBarOffset: -1 }]), /invalid data/);
  await assert.rejects(loadOne([{ ...fireball, bonusActionBarOffset: 1.5 }]), /invalid data/);
});

test("v11 only opens a special selection flow for an unambiguous DBC requirement", () => {
  assert.deepEqual(spellRequiredTargeting(0x40), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.Ground,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Ground,
  });
  assert.deepEqual(spellRequiredTargeting(0x10), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.Item,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Item,
  });
  assert.deepEqual(spellRequiredTargeting(0x42), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.Unit | SPELL_REQUIRED_TARGET_MASK.Ground,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Unknown,
  });
  assert.deepEqual(spellRequiredTargeting(0x60), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.Ground,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Unknown,
  });
  assert.deepEqual(spellRequiredTargeting(0x200), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.None,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Unknown,
  });
  assert.deepEqual(spellRequiredTargeting(0x800), {
    targetingContractVersion: 1,
    requiredTargetMask: SPELL_REQUIRED_TARGET_MASK.None,
    requiredTargetMode: SPELL_REQUIRED_TARGET_MODE.Unknown,
  });
});

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

test("Auto Shot and wand Shoot carry the DBC auto-repeat bit, ordinary Attack does not", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const spells = await loadSpellMetadata(dbcDirectory);
  assert.equal(spells.get(75)?.autoRepeat, true, "Auto Shot is a repeat container, not a recast loop");
  assert.equal(spells.get(5019)?.autoRepeat, true, "wand Shoot uses the same repeat container");
  assert.equal(spells.get(6603)?.autoRepeat, false, "the melee Attack client action uses ATTACK_SWING instead");
});

test("stance metadata preserves DBC order without mistaking the extra bar flag for all forms", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const spells = await loadSpellMetadata(dbcDirectory);
  assert.deepEqual([2457, 71, 2458].map((id) => spells.get(id)?.stanceBarOrder), [0, 1, 2]);
  for (const id of [2457, 71, 2458, 768, 5487]) {
    const spell = spells.get(id);
    assert.equal(spell.displayInStanceBar, false);
    assert.ok(spell.effectAura.includes(36), "ordinary forms are identified by MOD_SHAPESHIFT");
  }
  assert.equal(spells.get(465)?.displayInStanceBar, true, "Devotion Aura is an extra bar entry");
  assert.equal(spells.get(133)?.displayInStanceBar, false, "Fireball does not belong on the bar");
  const bonuses = parseSpellShapeshiftFormBonuses(await readFile(join(dbcDirectory,
    "SpellShapeshiftForm.dbc")));
  assert.deepEqual([17, 18, 19, 5, 8, 3].map((form) => bonuses.get(form)), [1, 2, 3, 3, 3, 0]);
  assert.deepEqual([2457, 71, 2458, 5487, 9634, 768, 783].map((id) =>
    spells.get(id)?.bonusActionBarOffset), [1, 2, 3, 3, 3, 1, 0],
  "spell aura form ID resolves through the authored BonusActionBar column");
  assert.equal(spells.get(465)?.bonusActionBarOffset, undefined,
    "flagged non-shapeshift auras do not invent a form action page");
  assert.throws(() => parseSpellShapeshiftFormBonuses(new Uint8Array([87, 68, 66, 67])),
    /SpellShapeshiftForm.dbc/);
});

test("11.10 every row the dataset's Spell.dbc yields passes the browser's guard", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  // One refused row refuses its whole `/dbc/spells` batch, and SpellNames.ts never asks for those
  // ids again: the rogue talent tree of 11.10 (Preparation 14185 and Hemorrhage 16511 carry
  // StanceBarOrder -1) lost every name and icon that way. The guard is for an older gateway's
  // shape, so the dataset's own rows — in JSON, as the route sends them — must all pass it.
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const spells = await loadSpellMetadata(dbcDirectory);
  const rows = new Map([...spells].map(([id, row]) => [id, JSON.parse(JSON.stringify(row))]));
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/", async (url) => {
    const ids = new URL(String(url)).searchParams.get("ids").split(",").map(Number);
    return { ok: true, json: async () => ids.map((id) => rows.get(id)).filter(Boolean) };
  });
  const loaded = await client.load([...rows.keys()]);
  assert.equal(loaded.size, rows.size);
  assert.equal(loaded.get(14185)?.stanceBarOrder, -1, "Preparation keeps its DBC order");
});
}

// ── spell-metadata-dedupe.test.mjs
{
// A crowd's aura packets used to call `load` once per packet, each with every aura id in view: two
// hundred overlapping requests before the first came back, and an id the gateway has no row for was
// asked again on every one of them. These pin the in-flight sharing and the answered-empty memory.

function row(id) {
  return {
    id, name: `Заклинание ${id}`, rank: "", description: "", iconId: 1, iconPath: "",
    passive: false, autoRepeat: false, displayInStanceBar: false, stanceBarOrder: 0,
    powerType: 0, powerCost: 0, powerCostPercent: 0, recoveryTime: 0, categoryRecoveryTime: 0,
    startRecoveryTime: 0, cooldownStartedOnEvent: false, effectAura: [0, 0, 0],
    effectMiscValue: [0, 0, 0], effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0],
    effectPeriod: [0, 0, 0], duration: 0, procChance: 0, spellLevel: 0, spellClassSet: 0,
    spellClassMask: [0, 0, 0], auraDescription: "",
    // The v=16 shape: a batch without `preventionType` is re-asked once past the HTTP cache (an old gateway).
    rangeMinFriendly: 0, rangeMaxFriendly: 0, dispelType: 0, preventionType: 0,
    startRecoveryCategory: 0, // L13: v=17's marker (a batch without it is the older gateway's)
    procCharges: 0, // 12.10: v=18's
    category: 0, // 3.39: v=19's
    speed: 0, // 3.01 (13.10): v=20's
  };
}

/** A gateway that holds every request until `release`, and knows only the ids in `known`. */
function gateway(known) {
  const requests = [];
  const held = [];
  const fetcher = (url) => {
    const ids = new URL(url).searchParams.get("ids").split(",").map(Number);
    requests.push(ids);
    return new Promise((resolve, reject) => {
      held.push({
        answer: () => resolve({ ok: true, json: async () => ids.filter((id) => known.has(id)).map(row) }),
        fail: () => reject(new Error("offline")),
      });
    });
  };
  return {
    requests,
    held,
    fetcher,
    release() { for (const request of held.splice(0)) request.answer(); },
  };
}

const settle = async () => { for (let round = 0; round < 8; round += 1) await Promise.resolve(); };

test("callers that need the same rows share the request already asking for them", async () => {
  const server = gateway(new Set([1, 2, 3, 4]));
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/", server.fetcher);
  const first = client.load([1, 2]);
  const second = client.load([1, 2, 3]);
  const third = client.load([2, 3, 4]);
  assert.deepEqual(server.requests, [[1, 2], [3], [4]], "each id is asked for once, by the first caller that needed it");
  server.release();
  await settle();
  server.release();
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.deepEqual([...a.keys()], [1, 2]);
  assert.deepEqual([...b.keys()], [1, 2, 3], "a caller gets the rows it waited for, in its own order");
  assert.deepEqual([...c.keys()], [2, 3, 4]);
  assert.equal(server.requests.length, 3);
});

test("an id answered without a row is not asked for again", async () => {
  const server = gateway(new Set([10]));
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/", server.fetcher);
  const pending = client.load([10, 61418]);
  server.release();
  const loaded = await pending;
  assert.deepEqual([...loaded.keys()], [10]);
  assert.equal(client.answered(61418), true, "the gateway's empty answer is final");
  assert.equal(client.answered(10), true);
  assert.equal(client.answered(99), false, "never asked is not answered");
  const again = await client.load([10, 61418]);
  assert.deepEqual([...again.keys()], [10]);
  assert.equal(server.requests.length, 1, "neither the row nor the known miss costs a second request");
});

test("a failed request remembers nothing, and a waiter asks for itself what the failure left", async () => {
  const server = gateway(new Set([7, 8]));
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/", server.fetcher);
  const owner = client.load([7]);
  const waiter = client.load([7, 8]);
  assert.deepEqual(server.requests, [[7], [8]]);
  const [shared, own] = server.held.splice(0);
  shared.fail();
  own.answer();
  await assert.rejects(owner, /offline/, "the caller whose request failed is told, as before");
  await settle();
  assert.equal(client.answered(7), false, "a failure is not an answer");
  assert.deepEqual(server.requests, [[7], [8], [7]],
    "the waiter asks for the id its shared request lost — the request it would have made alone");
  server.release();
  assert.deepEqual([...(await waiter).keys()], [7, 8]);
});

test("route-sized chunks are asked one after another and each chunk is shared on its own", async () => {
  const ids = Array.from({ length: 450 }, (_, index) => index + 1);
  const server = gateway(new Set(ids));
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/", server.fetcher);
  const all = client.load(ids);
  assert.equal(server.requests.length, 1, "the first chunk goes out at once, the rest wait their turn");
  assert.equal(server.requests[0].length, 200);
  const late = client.load([300, 451]);
  assert.deepEqual(server.requests.map((request) => request.length), [200, 1],
    "an id of a later chunk is not asked twice; a new id is");
  server.release();
  await settle();
  server.release();
  await settle();
  server.release();
  await settle();
  const [everything, some] = await Promise.all([all, late]);
  assert.equal(everything.size, 450);
  assert.deepEqual([...some.keys()], [300], "451 is unknown to this gateway");
  assert.deepEqual(server.requests.map((request) => request.length), [200, 1, 200, 50]);
});
}

// ── spell-metadata-usable.test.mjs
{
// 19.10: the `/dbc/spells?v=20` rows (19.10) add what IsUsableAction's per-slot check reads (src/browser/framexml/FrameXmlActionUsable.ts,
// Wow.exe 0x0080b5d0 / 0x0072bac0): ShapeshiftMask/ShapeshiftExclude (Spell 12-15), the aura states (20-23) and aura
// spells (24-27), AuraInterruptFlags (32), Mechanic (3), EffectMechanic (83-85), EffectSpellClassMaskA/B/C (122-130),
// and a MOD_SHAPESHIFT effect's SpellShapeshiftForm.dbc Flags (column 19). Values are this dataset's own rows.

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

const { parseSpellShapeshiftFormFlags } = await import("../dist/code/gateway/SpellShapeshiftForms.js");

test("parseSpellShapeshiftFormFlags reads column 19 of the 35-word record", () => {
  const fields = 35;
  const rows = [[17, 0], [30, 0], [1, 0]];
  const flags = [7, 1, 760];
  const out = Buffer.alloc(20 + rows.length * fields * 4 + 1);
  out.write("WDBC", 0, "latin1");
  out.writeUInt32LE(rows.length, 4);
  out.writeUInt32LE(fields, 8);
  out.writeUInt32LE(fields * 4, 12);
  out.writeUInt32LE(1, 16);
  rows.forEach(([id], row) => {
    out.writeUInt32LE(id, 20 + row * fields * 4);
    out.writeUInt32LE(flags[row], 20 + row * fields * 4 + 19 * 4);
  });
  assert.deepEqual([...parseSpellShapeshiftFormFlags(out)], [[17, 7], [30, 1], [1, 760]]);
});

test("served usability columns on the dataset's rogue, warrior and druid rows", withDataset, async () => {
  const { loadSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
  const spells = await loadSpellMetadata(dbcDirectory);
  const ambush = spells.get(8676);
  assert.deepEqual(ambush?.shapeshiftMask, [0x20000000, 0], "Внезапный удар: form 30 (stealth)");
  assert.deepEqual(ambush?.shapeshiftExclude, [0, 0]);
  assert.equal(spells.get(7384)?.shapeshiftMask?.[0], 0x10000, "Превосходство: form 17 (Battle Stance)");
  assert.equal(spells.get(1784)?.shapeshiftFormFlags, 1, "Незаметность: a stance-type form");
  assert.equal(spells.get(1784)?.auraInterruptFlags, 146436);
  assert.equal(spells.get(2457)?.shapeshiftFormFlags, 7, "Боевая стойка");
  assert.equal(spells.get(768)?.shapeshiftFormFlags, 760, "Облик кошки: a shapeshift (no 0x1)");
  assert.deepEqual(spells.get(768)?.shapeshiftExclude, [0x40000002, 0]);
  for (const id of [8676, 1784, 768]) {
    const masks = spells.get(id)?.effectSpellClassMask;
    assert.ok(Array.isArray(masks) && masks.length === 3 && masks.every((words) => words.length === 3), `spell ${id}`);
    assert.equal(spells.get(id)?.effectMechanic?.length, 3);
    for (const key of ["casterAuraState", "targetAuraState", "excludeCasterAuraState", "excludeTargetAuraState",
      "casterAuraSpell", "targetAuraSpell", "excludeCasterAuraSpell", "excludeTargetAuraSpell", "mechanic"]) {
      assert.ok(Number.isInteger(spells.get(id)?.[key]), `spell ${id} ${key}`);
    }
  }
  // An aura-state row: Execute (5308) asks the target's HEALTHLESS_20_PERCENT state.
  assert.equal(spells.get(5308)?.targetAuraState, 2, "Казнь");
});
}

// ── spell-metadata-v16.test.mjs
{
// A2-4 (/dbc/spells?v=16) on the real dataset: what the cast events (3.02), the combat log (3.01) and
// the multi-cast bar (3.07) read — DefenseType, PreventionType, the interrupt flag words raw, and the
// Call of the Elements slots Wow.exe files a learned player totem into (0x00542030 over 0x005a7b50).

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}

test("Wow.exe 0x005a7b50: totem category → slot bits, only for SPELL_ATTR7_SUMMON_PLAYER_TOTEM", async () => {
  const { totemCategorySlotMask, spellTotemSlotMask } = await import("../dist/code/gateway/SpellMetadata.js");
  assert.deepEqual([2, 3, 4, 5, 21, 1, 0].map(totemCategorySlotMask), [0x2, 0x8, 0x1, 0x4, 0xf, 0, 0]);
  assert.equal(spellTotemSlotMask(0x20, [4, 0]), 0x1);
  assert.equal(spellTotemSlotMask(0x20, [2, 5]), 0x6, "both categories count");
  assert.equal(spellTotemSlotMask(0, [4, 0]), 0, "a spell needing a totem but not summoning one fills no slot");
});

test("served v=16 columns match Spell.dbc on every row; the shaman's totems land in their slots", {
  skip: dbcDirectory ? false : "no tswow dataset on this machine",
}, async () => {
  const [{ openDbcFile }, { loadSpellMetadata, spellTotemSlotMask }] = await Promise.all([
    import("../dist/code/gateway/Dbc.js"),
    import("../dist/code/gateway/SpellMetadata.js"),
  ]);
  const [spells, metadata] = await Promise.all([openDbcFile(dbcDirectory, "Spell"), loadSpellMetadata(dbcDirectory)]);
  let rows = 0;
  let tableRows = 0;
  let totems = 0;
  for (const row of spells.rows()) {
    tableRows += 1;
    const id = spells.id(row);
    const served = metadata.get(id);
    if (!served) continue;
    rows += 1;
    assert.equal(served.dmgClass, spells.int(row, "DefenseType"), `spell ${id} DefenseType`);
    assert.equal(served.preventionType, spells.int(row, "PreventionType"), `spell ${id} PreventionType`);
    assert.equal(served.interruptFlags, spells.int(row, "InterruptFlags") >>> 0, `spell ${id} InterruptFlags`);
    assert.equal(served.channelInterruptFlags, spells.int(row, "ChannelInterruptFlags") >>> 0, `spell ${id}`);
    const mask = spellTotemSlotMask(spells.int(row, "AttributesExG"),
      [spells.int(row, "RequiredTotemCategoryID", 0), spells.int(row, "RequiredTotemCategoryID", 1)]);
    assert.equal(served.totemSlotMask, mask, `spell ${id} totemSlotMask`);
    if (mask !== 0) totems += 1;
  }
  // Every Spell.dbc row is served and checked. The base dataset (08.10) is the stock table, 49,839
  // rows up to id 80864; the install with modules had more than 70,000.
  assert.equal(rows, tableRows, `${rows} of ${tableRows} rows checked`);
  assert.ok(rows >= 49_839, `${rows} rows checked`);
  // With the module gem-abilities the built Spell.dbc has no RequiredTotemCategoryID on the shaman
  // totems (it clears RequiredTotems, gems.ts:488), so the client the realm patches — and Wow.exe
  // with it — files none of them into a multi-cast slot. The stock columns (dbc_source) do, and so
  // does the built table of the base dataset (08.10: 103 spells with a slot).
  const slot = (id) => metadata.get(id)?.totemSlotMask;
  const { tswowModuleInstalled } = await import("./fixtures/tswow-modules.mjs");
  if (!tswowModuleInstalled("gem-abilities")) {
    assert.deepEqual([3599, 8071, 5394, 8512].map(slot), [0x1, 0x2, 0x4, 0x8], "fire, earth, water, air");
    assert.ok(totems > 50, `${totems} totem spells file into a slot`);
  }
  assert.equal(slot(66842), 0, "Зов стихий summons no totem of its own");
  assert.equal(slot(133), 0, "Огненный шар");
  const sourceDirectory = dbcDirectory.replace(/[\\/]dbc[\\/]?$/, "/dbc_source");
  const source = await openDbcFile(sourceDirectory, "Spell").catch(() => undefined);
  if (source) {
    const stock = new Map();
    for (const row of source.rows()) {
      stock.set(source.id(row), spellTotemSlotMask(source.int(row, "AttributesExG"),
        [source.int(row, "RequiredTotemCategoryID", 0), source.int(row, "RequiredTotemCategoryID", 1)]));
    }
    assert.equal(stock.get(3599), 0x1, "Опаляющий тотем: fire");
    assert.equal(stock.get(8071), 0x2, "Тотем каменной кожи: earth");
    assert.equal(stock.get(5394), 0x4, "Тотем исцеляющего потока: water");
    assert.equal(stock.get(8512), 0x8, "Тотем неистовства ветра: air");
    assert.ok([...stock.values()].filter((mask) => mask !== 0).length > 50, "the stock totems");
  }
  assert.ok(totems >= 0);
  // PreventionType 1 is what Wow.exe 0x007262e0 calls interruptible: a magic cast, not a melee strike.
  assert.equal(metadata.get(133).preventionType, 1, "Огненный шар");
  assert.equal(metadata.get(78).preventionType, 2, "Удар героя");
  assert.equal(metadata.get(133).dmgClass, 1);
  assert.equal(metadata.get(78).dmgClass, 2);
  assert.equal(metadata.get(75).dmgClass, 3, "Автоматическая стрельба");
  // The interrupts and silences the player's book feeds into notInterruptible's masks.
  assert.ok(metadata.get(1766).effects.includes(68), "Пинок: SPELL_EFFECT_INTERRUPT_CAST");
  assert.ok(metadata.get(15487).effectAura.includes(27), "Безмолвие: SPELL_AURA_MOD_SILENCE");
});

test("the browser refuses a v=16 field that is not what it says", async () => {
  const { SpellMetadataClient } = await import("../dist/code/browser/SpellMetadata.js");
  const row = (extra) => ({
    id: 3599, name: "Опаляющий тотем", rank: "Уровень 1", description: "", iconId: 0, iconPath: "",
    passive: false, hidden: false, powerType: 0, powerCost: 0, powerCostPercent: 9, recoveryTime: 0,
    categoryRecoveryTime: 0, startRecoveryTime: 1000, cooldownStartedOnEvent: false,
    effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0],
    effectPeriod: [0, 0, 0], spellLevel: 10, spellClassSet: 11, spellClassMask: [0, 0, 0], schoolMask: 4,
    rangeMin: 0, rangeMax: 0, rangeFlags: 0, castTime: 0, duration: 0, procChance: 0,
    autoRepeat: false, displayInStanceBar: false, stanceBarOrder: 0,
    dispelType: 0, dmgClass: 1, preventionType: 1, interruptFlags: 15, channelInterruptFlags: 0, totemSlotMask: 1,
    startRecoveryCategory: 133, // L13: the v=17 marker, so the answer stands
    procCharges: 0, // 12.10: and v=18's
    category: 0, // 3.39: and v=19's
    speed: 0, // 13.10: and v=20's
    ...extra,
  });
  let rows = [row({})];
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push([String(url), init?.cache]);
    return { ok: true, status: 200, json: async () => rows };
  };
  const client = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  assert.equal((await client.load([3599])).get(3599).totemSlotMask, 1);
  assert.deepEqual(calls, [["http://127.0.0.1:8090/dbc/spells?ids=3599&v=20", undefined]], "a v=20 answer stands"); // 13.10: v=20; 3.39 (12.10: v=18; L13: v=17)
  rows = [row({ id: 3600, totemSlotMask: 16 })];
  await assert.rejects(client.load([3600]), /invalid data/, "four slots, four bits");
  rows = [row({ id: 3601, preventionType: "1" })];
  await assert.rejects(client.load([3601]), /invalid data/);
});
}

// ── spell-metadata-v17.test.mjs
{
// L13 (04.10): `/dbc/spells?v=17` adds the columns several plan items stopped at — StartRecoveryCategory
// (5.30: the realm keys its global cooldowns by it and starts none for 0, Spell.cpp:8698; Wow.exe
// 0x00807980 holds a spell while a global part of the same category runs), EffectMiscValueB[3] and, for a
// SPELL_EFFECT_SUMMON (28), the SummonProperties.dbc row it names (3.12: Wow.exe 0x0061e830's Title,
// TrinityCore DBCfmt.h "niiiii": ID, Control, Faction, Title, Slot, Flags). The columns are checked
// against tools/dbd (Spell 113-115, 205) and DBCStructure.h:1487, 1504, 1680-1688.

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

const { DBC_LAYOUTS } = await import("../dist/code/generated/dbcLayouts.js");
const { parseSpellMetadata } = await import("../dist/code/gateway/SpellMetadata.js");
const { parseSummonProperties, spellSummonProperties } = await import("../dist/code/gateway/SummonPropertiesMetadata.js");

/** A WDBC image of `fields` 32-bit words a record. */
function image(fields, records, strings = Buffer.from([0])) {
  const recordSize = fields * 4;
  const out = Buffer.alloc(20 + records.length * recordSize + strings.length);
  out.write("WDBC", 0, "latin1");
  out.writeUInt32LE(records.length, 4);
  out.writeUInt32LE(fields, 8);
  out.writeUInt32LE(recordSize, 12);
  out.writeUInt32LE(strings.length, 16);
  records.forEach((words, row) => words.forEach((word, index) => out.writeInt32LE(word | 0, 20 + row * recordSize + index * 4)));
  strings.copy(out, 20 + records.length * recordSize);
  return out;
}
const empty = (table) => image(DBC_LAYOUTS[table].fieldCount, []);

/** A Spell.dbc record: Effect 71-73, EffectMiscValueB 113-115, StartRecoveryCategory 205, StartRecoveryTime 206. */
function spell(id, columns) {
  const words = Array(DBC_LAYOUTS.Spell.fieldCount).fill(0);
  words[0] = id;
  for (const [index, value] of Object.entries(columns)) words[Number(index)] = value;
  return words;
}
// The dataset's own values (Spell.dbc, SummonProperties.dbc, read 2026-10-04).
const SPELLS = [
  spell(133, { 71: 2, 72: 6, 205: 133, 206: 1500 }), // Огненный шар
  spell(45469, { 71: 6, 205: 0, 206: 1500 }), // Удар смерти: category 0 with a time
  spell(48941, { 71: 65, 205: 38, 206: 1500 }), // Аура благочестия: category 38
  spell(7744, { 71: 6, 72: 6, 73: 6, 205: 133, 206: 0 }), // Воля Отрекшихся: 133 without a time
  spell(3599, { 71: 28, 113: 63, 205: 133, 206: 1000 }), // Опаляющий тотем → SummonProperties 63
  spell(49206, { 71: 28, 72: 6, 73: 64, 113: 209, 205: 133, 206: 1500 }), // Призыв горгульи → 209
  spell(4242, { 71: 6, 72: 28, 114: 9999 }), // a summon in the second effect naming no row
];
const SUMMON_PROPERTIES = [[63, 1, 0, 4, 1, 2], [209, 1, 0, 7, 0, 512], [1021, 1, 0, 0, 0, 512], [61, 1, 0, -1, 0, 0]];

test("parseSummonProperties: every column, Title signed; another layout is not read", () => {
  const table = parseSummonProperties(image(6, SUMMON_PROPERTIES));
  assert.deepEqual(table.get(63), { id: 63, control: 1, faction: 0, title: 4, slot: 1, flags: 2 });
  assert.equal(table.get(61).title, -1, "-1 asks Wow.exe 0x0061e830 for the default title");
  assert.equal(table.size, 4);
  assert.equal(parseSummonProperties(image(5, [[63, 1, 0, 4, 1]])).size, 0, "five columns: not SummonProperties");
  const twelveHalves = image(6, SUMMON_PROPERTIES);
  twelveHalves.writeUInt32LE(12, 8); // the same 24 bytes a row, as twelve 16-bit columns
  assert.equal(parseSummonProperties(twelveHalves).size, 0, "the column count is checked, not only the size");
  assert.equal(parseSummonProperties(Buffer.from("WDBX")).size, 0);
  const truncated = image(6, SUMMON_PROPERTIES).subarray(0, 40);
  assert.equal(parseSummonProperties(truncated).size, 0, "a short file is refused whole");
  // Only SPELL_EFFECT_SUMMON effects name a row; the rest are null, a spell without one has none.
  assert.deepEqual(spellSummonProperties([6, 28, 0], [63, 209, 0], table), [null, table.get(209), null]);
  assert.deepEqual(spellSummonProperties([28, 0, 0], [5, 0, 0], table), [null, null, null], "an id the table lacks");
  assert.equal(spellSummonProperties([6, 2, 0], [63, 0, 0], table), undefined);
});

test("v=17 rows: StartRecoveryCategory and EffectMiscValueB on every row, summon rows resolved", () => {
  const spells = image(DBC_LAYOUTS.Spell.fieldCount, SPELLS);
  const parsed = parseSpellMetadata(spells, empty("SpellIcon"), undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, image(6, SUMMON_PROPERTIES));
  const row = (id) => parsed.get(id);
  assert.deepEqual([133, 45469, 48941, 7744].map((id) => [row(id).startRecoveryCategory, row(id).startRecoveryTime]),
    [[133, 1500], [0, 1500], [38, 1500], [133, 0]]);
  assert.deepEqual(row(133).effectMiscValueB, [0, 0, 0]);
  assert.equal(row(133).summonProperties, undefined, "no summon effect: no field");
  assert.deepEqual(row(3599).effectMiscValueB, [63, 0, 0]);
  assert.deepEqual(row(3599).summonProperties, [{ id: 63, control: 1, faction: 0, title: 4, slot: 1, flags: 2 }, null, null]);
  assert.equal(row(49206).summonProperties[0].title, 7, "the gargoyle: UNITNAME_SUMMON_TITLE7");
  assert.deepEqual(row(4242).summonProperties, [null, null, null], "the summon names no row: the default title");
  assert.deepEqual(row(4242).effectMiscValueB, [0, 9999, 0]);
  // A dataset without the table: the category and the raw column, but no summon rows (unknown, not «no row»).
  const bare = parseSpellMetadata(spells, empty("SpellIcon"));
  assert.equal(bare.get(3599).summonProperties, undefined);
  assert.equal(bare.get(3599).startRecoveryCategory, 133);
  assert.deepEqual(bare.get(3599).effectMiscValueB, [63, 0, 0]);
});

test("the /dbc/spells route answers the v=17 columns (in process, synthetic DBC directory)", async () => {
  const { startGateway } = await import("../dist/code/gateway/Gateway.js");
  const directory = await mkdtemp(join(tmpdir(), "l13-dbc-"));
  await writeFile(join(directory, "Spell.dbc"), image(DBC_LAYOUTS.Spell.fieldCount, SPELLS));
  for (const table of ["SpellIcon", "SpellDuration", "SpellRadius", "SpellCategory", "SpellRange", "SpellCastTimes"]) {
    await writeFile(join(directory, `${table}.dbc`), empty(table));
  }
  await writeFile(join(directory, "SummonProperties.dbc"), image(6, SUMMON_PROPERTIES));
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"], dbcDirectory: directory,
  });
  try {
    const base = `http://127.0.0.1:${gateway.port}/dbc/spells`;
    const headers = { origin: "http://127.0.0.1:5173" };
    const response = await fetch(`${base}?ids=45469,3599,133&v=17`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");
    assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate", "revalidated like every dataset route");
    const rows = new Map((await response.json()).map((row) => [row.id, row]));
    assert.equal(rows.get(45469).startRecoveryCategory, 0);
    assert.equal(rows.get(133).startRecoveryCategory, 133);
    assert.deepEqual(rows.get(3599).summonProperties[0], { id: 63, control: 1, faction: 0, title: 4, slot: 1, flags: 2 });
    assert.equal((await fetch(`${base}?ids=133&v=17`)).status, 403, "the Origin rule");
    assert.equal((await fetch(`${base}?ids=&v=17`, { headers })).status, 400);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("served v=17 columns match Spell.dbc and SummonProperties.dbc on every row of the dataset", withDataset, async () => {
  const [{ openDbcFile }, { loadSpellMetadata }, { readFile }] = await Promise.all([
    import("../dist/code/gateway/Dbc.js"), import("../dist/code/gateway/SpellMetadata.js"), import("node:fs/promises"),
  ]);
  const [spells, metadata, summon] = await Promise.all([
    openDbcFile(dbcDirectory, "Spell"), loadSpellMetadata(dbcDirectory), readFile(join(dbcDirectory, "SummonProperties.dbc")),
  ]);
  const table = parseSummonProperties(summon);
  assert.ok(table.size > 100, `${table.size} SummonProperties rows`);
  let rows = 0;
  let tableRows = 0;
  let summons = 0;
  for (const row of spells.rows()) {
    tableRows += 1;
    const id = spells.id(row);
    const served = metadata.get(id);
    if (!served) continue;
    rows += 1;
    assert.equal(served.startRecoveryCategory, spells.int(row, "StartRecoveryCategory"), `spell ${id}`);
    const effects = [0, 1, 2].map((index) => spells.int(row, "Effect", index));
    const miscValueB = [0, 1, 2].map((index) => spells.int(row, "EffectMiscValueB", index));
    assert.deepEqual(served.effectMiscValueB, miscValueB, `spell ${id}`);
    if (!effects.includes(28)) {
      assert.equal(served.summonProperties, undefined, `spell ${id}`);
      continue;
    }
    summons += 1;
    assert.deepEqual(served.summonProperties,
      effects.map((effect, index) => (effect === 28 ? table.get(miscValueB[index]) ?? null : null)), `spell ${id}`);
  }
  // Every Spell.dbc row: 49,839 on the base dataset (08.10, the stock table), over 70,000 with modules.
  assert.equal(rows, tableRows, `${rows} of ${tableRows} rows`);
  assert.ok(rows >= 49_839, `${rows} rows`);
  assert.ok(summons > 2_000, `${summons} summon rows`);
  const at = (id) => metadata.get(id);
  assert.deepEqual([at(7744).startRecoveryCategory, at(7744).startRecoveryTime], [133, 0], "Воля Отрекшихся");
  assert.deepEqual([at(45469).startRecoveryCategory, at(45469).startRecoveryTime], [0, 1500], "Удар смерти");
  assert.equal(at(48941).startRecoveryCategory, 38, "Аура благочестия");
  assert.equal(at(3599).summonProperties[0].title, 4, "Опаляющий тотем: «Тотем»");
  assert.equal(at(58833).summonProperties[0].title, 0, "Зеркальное изображение: no title line");
  assert.equal((at(33395).attributes[4] & 0x20), 0x20, "Холод: AttributesEx4 0x20 (11.02-D)");
});

test("the browser asks v=19; a batch without v=19's category is asked once more past the cache", async () => {
  const { SpellMetadataClient } = await import("../dist/code/browser/SpellMetadata.js");
  const row = (extra) => ({
    id: 3599, name: "Опаляющий тотем", rank: "", description: "", iconId: 0, iconPath: "",
    passive: false, hidden: false, powerType: 0, powerCost: 0, powerCostPercent: 9, recoveryTime: 0,
    categoryRecoveryTime: 0, startRecoveryTime: 1000, cooldownStartedOnEvent: false,
    effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], effectBasePoints: [0, 0, 0], effectDieSides: [0, 0, 0],
    effectPeriod: [0, 0, 0], spellLevel: 10, spellClassSet: 11, spellClassMask: [0, 0, 0], schoolMask: 4,
    rangeMin: 0, rangeMax: 0, rangeFlags: 0, castTime: 0, duration: 0, procChance: 0,
    autoRepeat: false, displayInStanceBar: false, stanceBarOrder: 0, effects: [28, 0, 0],
    dispelType: 0, dmgClass: 1, preventionType: 1, interruptFlags: 15, channelInterruptFlags: 0, totemSlotMask: 1,
    ...extra,
  });
  const calls = [];
  let rows = [row({})];
  const fetcher = async (url, init) => {
    calls.push([String(url), init?.cache]);
    return { ok: true, status: 200, json: async () => rows };
  };
  const old = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  assert.equal((await old.load([3599])).get(3599).startRecoveryCategory, undefined, "a v=16 row still loads");
  assert.deepEqual(calls, [
    ["http://127.0.0.1:8090/dbc/spells?ids=3599&v=20", undefined], // 13.10: v=20 (3.39: v=19; 12.10: v=18)
    ["http://127.0.0.1:8090/dbc/spells?ids=3599&v=20", "reload"],
  ], "the v=16 shape is an older gateway for the v=20 key");

  calls.length = 0;
  const totem = { id: 63, control: 1, faction: 0, title: 4, slot: 1, flags: 2 };
  rows = [row({ startRecoveryCategory: 133, procCharges: 0, category: 0, speed: 0, effectMiscValueB: [63, 0, 0], summonProperties: [totem, null, null] })];
  const fresh = new SpellMetadataClient("ws://127.0.0.1:8090/auth", fetcher);
  const loaded = (await fresh.load([3599])).get(3599);
  assert.equal(loaded.startRecoveryCategory, 133);
  assert.equal(loaded.summonProperties[0].title, 4);
  assert.equal(calls.length, 1, "a v=20 answer stands");
  // 3.39: a v=18 row (procCharges, no category) is an older gateway's for the v=19 key: asked once more.
  calls.length = 0;
  rows = [row({ id: 3598, startRecoveryCategory: 133, procCharges: 0 })];
  assert.equal((await fresh.load([3598])).get(3598).category, undefined, "a v=18 row still loads");
  assert.deepEqual(calls.map(([, cache]) => cache), [undefined, "reload"]);
  const refused = async (id, extra, message) => {
    rows = [row({ id, startRecoveryCategory: 133, procCharges: 0, category: 0, speed: 0, ...extra })];
    await assert.rejects(fresh.load([id]), /invalid data/, message);
  };
  await refused(3600, { startRecoveryCategory: "133" }, "a category is a number");
  await refused(3601, { startRecoveryCategory: -1 }, "and not negative");
  await refused(3602, { effectMiscValueB: [63, 0] }, "three effects");
  await refused(3603, { summonProperties: [{ ...totem, title: "4" }, null, null] }, "a summon row is numbers");
  await refused(3604, { summonProperties: [totem, null] }, "one entry per effect");
  await refused(3605, { summonProperties: [7, null, null] }, "an entry is a row or null");
  await refused(3606, { category: "4" }, "3.39: a cooldown category is a number");
  await refused(3607, { category: -4 }, "3.39: and not negative");
  await refused(3608, { category: 4.5 }, "3.39: and whole");
});
}

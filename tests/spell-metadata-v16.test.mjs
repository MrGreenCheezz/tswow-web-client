import assert from "node:assert/strict";
import test from "node:test";

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
  let totems = 0;
  for (const row of spells.rows()) {
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
  assert.ok(rows > 70_000, `${rows} rows checked`);
  // This dataset's built Spell.dbc has no RequiredTotemCategoryID on the shaman totems (the module
  // gem-abilities clears RequiredTotems, gems.ts:488), so the client the realm patches — and Wow.exe
  // with it — files none of them into a multi-cast slot. The stock columns (dbc_source) do.
  const slot = (id) => metadata.get(id)?.totemSlotMask;
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
  assert.deepEqual(calls, [["http://127.0.0.1:8090/dbc/spells?ids=3599&v=17", undefined]], "a v=17 answer stands"); // L13
  rows = [row({ id: 3600, totemSlotMask: 16 })];
  await assert.rejects(client.load([3600]), /invalid data/, "four slots, four bits");
  rows = [row({ id: 3601, preventionType: "1" })];
  await assert.rejects(client.load([3601]), /invalid data/);
});

import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.12 (04.10, L4) and 5.28's loot lines: what GameTooltip:SetUnit writes from the world
// beyond the name, as Wow.exe 3.3.5a 12340 does (0x00621070, read 2026-10-04): any player's guild from
// the guild cache (0x0067d930), the colour-blind standing label (0x00621504), UNITNAME_SUMMON_TITLE
// (0x0061e830) and a corpse's MASTER_LOOTER/LOOT lines (0x0062220c).
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const {
  FrameXmlUnitTooltipRefresh, frameXmlUnitGuildName, frameXmlUnitPendingAnswers, frameXmlUnitSummonTitle,
} = await import("../dist/code/browser/framexml/FrameXmlUnitTooltipExtras.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { PacketWriter } = await import("../dist/code/protocol/PacketWriter.js");
const { PacketReader } = await import("../dist/code/protocol/PacketReader.js");

const F = (name) => UPDATE_FIELDS[name].offset;
function object(guid, typeId, fields) {
  const map = new Map();
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "bigint") {
      map.set(F(name), Number(value & 0xffffffffn));
      map.set(F(name) + 1, Number(value >> 32n));
    } else map.set(F(name), value);
  }
  return { guid, typeId, fields: map };
}

const PLAYER = 0x10n;
const HUNTER = 0x20n;
const PET = 0xf130000123000040n; // a creature guid (entry 0x1230)
const WOLF = 0xf130000456000050n;

function world(objects, { names = new Map(), templates = new Map(), guilds = new Map() } = {}) {
  const asked = { names: [], guilds: [] };
  return {
    asked,
    state: { objects: new Map(objects.map((entry) => [entry.guid, entry])) },
    names: { get: (guid) => names.get(guid) },
    requestName(guid) { asked.names.push(guid); },
    creatureTemplates: templates,
    petNameOf: () => undefined,
    guildNames: { name: (id) => guilds.get(id) },
    queryGuildName(id) { asked.guilds.push(id); },
  };
}

test("guild: any player's guild from the cache by PLAYER_GUILDID; a miss asks once and writes none", () => {
  const stranger = object(0x99n, 4, { PLAYER_GUILDID: 42 });
  const w = world([stranger], { guilds: new Map([[7, "Щит"]]) });
  assert.equal(frameXmlUnitGuildName(w, stranger), undefined, "not cached yet");
  assert.deepEqual(w.asked.guilds, [42]);
  const member = object(0x98n, 4, { PLAYER_GUILDID: 7 });
  assert.equal(frameXmlUnitGuildName(w, member), "Щит");
  assert.equal(frameXmlUnitGuildName(w, object(0x97n, 4, {})), undefined, "no guild (a zero field is absent)");
  assert.equal(frameXmlUnitGuildName(w, object(0x96n, 3, { PLAYER_GUILDID: 7 })), undefined, "only players");
  assert.deepEqual(w.asked.guilds, [42]);
});

test("summon title: owner by CHARMEDBY then CREATEDBY, the owner's owner, the creature-type default", () => {
  const templates = new Map([
    [0x1230, { found: true, name: "Волк охотника", creatureType: 1 }],
    [0x4560, { found: true, name: "Бес", creatureType: 3 }],
  ]);
  const hunter = object(HUNTER, 4, {});
  const pet = object(PET, 3, { OBJECT_FIELD_ENTRY: 0x1230, UNIT_FIELD_CREATEDBY: HUNTER });
  const imp = object(WOLF, 3, { OBJECT_FIELD_ENTRY: 0x4560, UNIT_FIELD_CREATEDBY: HUNTER, UNIT_CREATED_BY_SPELL: 688 });
  const w = world([hunter, pet, imp], { names: new Map([[HUNTER, "Охотник"]]), templates });
  const spells = new Map([[688, [56, 0, 0]], [31687, [28, 0, 0]]]);
  const sources = { spellEffects: (id) => spells.get(id) };
  assert.deepEqual(frameXmlUnitSummonTitle(w, pet, sources), { globalName: "UNITNAME_SUMMON_TITLE1", ownerName: "Охотник" },
    "a beast: «Питомец»");
  assert.deepEqual(frameXmlUnitSummonTitle(w, imp, sources), { globalName: "UNITNAME_SUMMON_TITLE3", ownerName: "Охотник" },
    "SUMMON_PET (56) is no summon effect: the default, a demon is «Прислужник»");
  // A charmer comes before the creator.
  const charmed = object(0xf130000456000060n, 3, { OBJECT_FIELD_ENTRY: 0x4560, UNIT_FIELD_CHARMEDBY: 0x11n, UNIT_FIELD_CREATEDBY: HUNTER });
  const w2 = world([charmed], { names: new Map([[0x11n, "Жрец"], [HUNTER, "Охотник"]]), templates });
  assert.equal(frameXmlUnitSummonTitle(w2, charmed, sources)?.ownerName, "Жрец");
  // A totem of a pet: the pet in view has an owner, so the line names that one (0x004f5f20).
  const totem = object(0xf130000456000070n, 3, { OBJECT_FIELD_ENTRY: 0x4560, UNIT_FIELD_CREATEDBY: PET });
  assert.equal(frameXmlUnitSummonTitle(w, totem, sources)?.ownerName, "Охотник");
  // Unknown owner name: asked for, the binder writes UNKNOWNOBJECT.
  const orphan = object(0xf130000456000080n, 3, { OBJECT_FIELD_ENTRY: 0x4560, UNIT_FIELD_CREATEDBY: 0x77n });
  assert.deepEqual(frameXmlUnitSummonTitle(w, orphan, sources), { globalName: "UNITNAME_SUMMON_TITLE3", ownerName: undefined });
  assert.deepEqual(w.asked.names, [0x77n]);
  // A spell with SPELL_EFFECT_SUMMON needs SummonProperties.Title, which is not served: no line.
  const elemental = object(0xf130000456000090n, 3, { OBJECT_FIELD_ENTRY: 0x4560, UNIT_FIELD_CREATEDBY: HUNTER, UNIT_CREATED_BY_SPELL: 31687 });
  assert.equal(frameXmlUnitSummonTitle(w, elemental, sources), undefined);
  // …and with it: 0 writes nothing, -1 falls to the default, n is TITLE<n>.
  const titled = (title) => frameXmlUnitSummonTitle(w, elemental, { ...sources, summonPropertiesTitle: () => title });
  assert.equal(titled(0), undefined);
  assert.equal(titled(-1)?.globalName, "UNITNAME_SUMMON_TITLE3");
  assert.equal(titled(4)?.globalName, "UNITNAME_SUMMON_TITLE4");
  // A spell row not loaded yet: no guess.
  const unknown = object(0xf1300004560000a0n, 3, { OBJECT_FIELD_ENTRY: 0x4560, UNIT_FIELD_CREATEDBY: HUNTER, UNIT_CREATED_BY_SPELL: 999 });
  assert.equal(frameXmlUnitSummonTitle(w, unknown, sources), undefined);
  assert.equal(frameXmlUnitSummonTitle(w, object(0xf1300004560000b0n, 3, { OBJECT_FIELD_ENTRY: 0x4560 }), sources), undefined, "no owner");
  // A creature owner out of view goes by its entry's cached name.
  const ward = object(0xf1300004560000c0n, 3, { OBJECT_FIELD_ENTRY: 0x4560, UNIT_FIELD_CREATEDBY: 0xf130001230000999n });
  assert.equal(frameXmlUnitSummonTitle(w, ward, sources)?.ownerName, "Волк охотника");
});

test("pending answers: the guild or a loot owner's name; the wait fires once, and a newer wait replaces it", () => {
  const guilds = new Map();
  const names = new Map();
  const w = world([], { names, guilds });
  const member = object(0x98n, 4, { PLAYER_GUILDID: 7 });
  const owners = (masterLooterGuid, allowedLooterGuid) => ({ masterLooterGuid, allowedLooterGuid });
  assert.equal(frameXmlUnitPendingAnswers(w, object(0x97n, 4, {}), undefined), undefined, "nothing pending");
  const ready = frameXmlUnitPendingAnswers(w, member, owners(0x55n, 0n));
  assert.equal(ready(), false);
  names.set(0x55n, "Лидер");
  assert.equal(ready(), true, "a loot owner's name came");
  names.clear();
  w.group = { members: [{ guid: 0x56n, name: "Вор" }] };
  assert.equal(frameXmlUnitPendingAnswers(w, object(0x97n, 3, {}), owners(0n, 0x56n)), undefined,
    "a group member's name is known from the group list, as the loot line reads it");
  const guildReady = frameXmlUnitPendingAnswers(w, member, undefined);
  guilds.set(7, "Щит");
  assert.equal(guildReady(), true, "the guild came");
  assert.equal(frameXmlUnitPendingAnswers(w, member, undefined), undefined, "known now");

  const refresh = new FrameXmlUnitTooltipRefresh();
  let first = 0, second = 0, gate = false;
  refresh.watch(() => gate, () => { first++; });
  const cancel = refresh.watch(() => gate, () => { second++; });
  refresh.tick();
  gate = true;
  refresh.tick();
  refresh.tick();
  assert.deepEqual([first, second], [0, 1], "only the newest wait, once");
  refresh.watch(() => true, () => { first++; });
  cancel();
  refresh.tick();
  assert.equal(first, 1, "an old cancel does not withdraw a newer wait");
  const third = refresh.watch(() => true, () => { first++; });
  third();
  refresh.tick();
  assert.equal(first, 1, "withdrawn");
});

async function bootTooltip(adapter, extraLua = "") {
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "TooltipFonts.xml\nTooltip.lua",
      "interface/framexml/tooltipfonts.xml": `<Ui>
        <Font name="GameTooltipHeaderText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="14"/></FontHeight></Font>
        <Font name="GameTooltipText" font="Fonts\\FRIZQT__.TTF"><FontHeight><AbsValue val="12"/></FontHeight></Font>
      </Ui>`,
      "interface/framexml/tooltip.lua": `
UIParent = CreateFrame("Frame", "UIParent")
UIParent:SetSize(1024, 768)
GameTooltip = CreateFrame("GameTooltip", "GameTooltip", UIParent)
TOOLTIP_UNIT_LEVEL = "Уровень %s"
TOOLTIP_UNIT_LEVEL_TYPE = "Уровень %s (%s)"
TOOLTIP_UNIT_LEVEL_RACE_CLASS = "Уровень %s %s %s"
FACTION_STANDING_LABEL2 = "Враждебность"
FACTION_STANDING_LABEL5 = "Дружелюбие"
FACTION_STANDING_LABEL5_FEMALE = "Дружелюбие (ж)"
UNITNAME_SUMMON_TITLE1 = "Питомец |3-1(%s)"
UNKNOWNOBJECT = "Неизвестно"
MASTER_LOOTER = "Ответственный за добычу"
LOOT = "Добыча"
UNIT_SKINNABLE_LEATHER = "Можно снять шкуру"
CVars = { colorblindMode = false }
function GetCVarBool(name) return CVars[name] end
Sex = 2
function UnitSex(unit) if unit == "player" then return Sex end end
function UnitExists(unit) return unit == "target" or unit == "mouseover" end
function UnitName(unit) if unit == "target" then return "Волк" end if unit == "mouseover" then return "Чужак" end end
function UnitIsPlayer(unit) return unit == "mouseover" end
function UnitRace() return "Человек" end
function UnitClass() return "Воин" end
function UnitLevel() return 80 end
function UnitCreatureType(unit) if unit == "target" then return "Животное" end end
function UnitIsPVP() return false end
function UnitReaction(unit, other) if other == "player" then return unit == "target" and 2 or 5 end end
Dead = false
function UnitIsDead(unit) return Dead end
function GetGuildInfo(unit) return nil end
${extraLua}
`,
    }),
    subset: ["TooltipFonts.xml", "Tooltip.lua"],
    exercise: false,
    gameTooltipAdapter: {
      inventoryItem: () => undefined, containerItem: () => undefined, item: () => undefined, spell: () => undefined,
      ...adapter,
    },
  });
  await boot.load();
  const run = (source, results = 0) => {
    const chunk = boot.vm.compileFunction(source, "@unit-tooltip-lines", []);
    assert.ok(chunk, `compiles: ${source}`);
    try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
  };
  const lines = () => {
    const out = [];
    const count = run(`return GameTooltip:NumLines()`, 1)[0];
    for (let index = 1; index <= count; index++) out.push(boot.bridge.getFrame(`GameTooltipTextLeft${index}`)?.text);
    return out;
  };
  return { boot, run, lines };
}

test("SetUnit: guild from the cache, standing label only in colour-blind mode, summon title under the sub-name", async () => {
  const asked = [];
  const { boot, run, lines } = await bootTooltip({
    unitGuildName: (unit) => { asked.push(unit); return unit === "mouseover" ? "Чужая гильдия" : undefined; },
    unitSubName: (unit) => unit === "target" ? "Питомец-волк" : undefined,
    unitSummonTitle: (unit) => unit === "target" ? { globalName: "UNITNAME_SUMMON_TITLE1", ownerName: undefined } : undefined,
  });
  try {
    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")`);
    run(`GameTooltip:SetUnit("mouseover")`);
    assert.deepEqual(lines(), ["Чужак", "Чужая гильдия", "Уровень 80 Человек Воин"], "another player's guild line");
    run(`GameTooltip:SetUnit("target")`);
    assert.deepEqual(lines(), ["Волк", "Питомец-волк", "Питомец |3-1(Неизвестно)", "Уровень 80 (Животное)"],
      "UNKNOWNOBJECT while the owner's name is on its way");
    assert.deepEqual(asked, ["mouseover"], "no guild asked for a creature");
    run(`CVars.colorblindMode = true`);
    run(`GameTooltip:SetUnit("target")`);
    assert.deepEqual(lines(), ["Волк", "Враждебность", "Питомец-волк", "Питомец |3-1(Неизвестно)", "Уровень 80 (Животное)"],
      "the standing (UnitReaction(unit, \"player\")) right after the name, before the sub-name");
    run(`Sex = 3 GameTooltip:SetUnit("mouseover")`);
    assert.deepEqual(lines(), ["Чужак", "Чужая гильдия", "Дружелюбие (ж)", "Уровень 80 Человек Воин"],
      "after the guild, in the player's gender (_FEMALE)");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("SetUnit: a corpse's loot owners close the tooltip, only while the unit is dead", async () => {
  const { boot, run, lines } = await bootTooltip({
    unitLootOwners: () => [{ globalName: "MASTER_LOOTER", name: "Лидер" }, { globalName: "LOOT", name: "Вор" }],
    unitSkinnable: () => ({ globalName: "UNIT_SKINNABLE_LEATHER", prefix: "", color: { r: 1, g: 1, b: 1 } }),
  });
  try {
    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE")`);
    run(`GameTooltip:SetUnit("target")`);
    assert.deepEqual(lines(), ["Волк", "Уровень 80 (Животное)", "Можно снять шкуру"], "alive: no loot lines");
    run(`Dead = true GameTooltip:SetUnit("target")`);
    assert.deepEqual(lines(), ["Волк", "Уровень 80 (Животное)", "Можно снять шкуру",
      "Ответственный за добычу: Лидер", "Добыча: Вор"]);
    const color = boot.bridge.getFrame("GameTooltipTextLeft4")?.textColor;
    assert.deepEqual([color.r, color.g, color.b], [1, 1, 1], "white (0x00ad2d30)");
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("SetUnit waits for a pending guild and draws the unit again when it comes; hiding withdraws the wait", async () => {
  let guild;
  let redraw;
  let withdrawn = 0;
  let watched = 0;
  const { boot, run, lines } = await bootTooltip({
    unitGuildName: () => guild,
    watchUnitAnswers: (unit, callback) => {
      watched++;
      if (guild !== undefined) return undefined;
      redraw = callback;
      return () => { withdrawn++; };
    },
  });
  try {
    run(`OnSet = 0 GameTooltip:SetScript("OnTooltipSetUnit", function() OnSet = OnSet + 1 end)`);
    run(`GameTooltip:SetOwner(UIParent, "ANCHOR_NONE") GameTooltip:SetUnit("mouseover")`);
    assert.deepEqual(lines(), ["Чужак", "Уровень 80 Человек Воин"]);
    guild = "Чужая гильдия";
    redraw();
    assert.deepEqual(lines(), ["Чужак", "Чужая гильдия", "Уровень 80 Человек Воин"], "drawn again with the guild");
    assert.equal(boot.vm.getGlobal("OnSet"), 2, "OnTooltipSetUnit again, as a fresh SetUnit");
    guild = undefined;
    run(`GameTooltip:SetUnit("mouseover")`);
    const stale = redraw;
    const before = withdrawn;
    run(`GameTooltip:Hide()`);
    assert.equal(withdrawn, before + 1, "hiding withdrew the wait");
    guild = "Чужая гильдия";
    stale();
    assert.equal(boot.bridge.getFrame("GameTooltip")?.visible, false, "a late answer does not bring a hidden tooltip back");
    assert.ok(watched >= 3);
    assert.deepEqual(boot.errors, []);
  } finally { boot.close(); }
});

test("the live seam and the tooltip adapter carry the guild, the summon title and the wait", async () => {
  const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
  const { createFrameXmlCharacterTooltipAdapter } = await import("../dist/code/browser/framexml/FrameXmlCharacterTooltip.js");
  const self = object(0x10n, 4, {});
  const stranger = object(0x99n, 4, { PLAYER_GUILDID: 42 });
  const wolf = object(PET, 3, { OBJECT_FIELD_ENTRY: 0x1230, UNIT_FIELD_CREATEDBY: 0x10n });
  const guilds = new Map();
  const asked = [];
  const w = {
    targetGuid: stranger.guid,
    state: { selfGuid: self.guid, objects: new Map([[self.guid, self], [stranger.guid, stranger], [wolf.guid, wolf]]) },
    names: { get: (guid) => guid === 0x10n ? "Охотник" : undefined },
    selfName: "Охотник",
    requestName() {},
    creatureTemplates: new Map([[0x1230, { found: true, name: "Волк", creatureType: 1 }]]),
    creatureTemplate: () => ({ found: true, flags: 0 }),
    guildNames: { name: (id) => guilds.get(id) },
    queryGuildName(id) { asked.push(id); },
  };
  const seam = new LiveWorldSeam({ world: () => w, spell: () => undefined });
  const adapter = createFrameXmlCharacterTooltipAdapter(seam);
  assert.equal(adapter.unitGuildName("target"), undefined);
  assert.deepEqual(asked, [42]);
  // (The per-frame poll is LiveWorldSeam.tick's, which needs an attached pump: FrameXmlUnitTooltipRefresh above.)
  const cancel = adapter.watchUnitAnswers("target", () => {});
  assert.equal(typeof cancel, "function", "the guild is pending");
  cancel();
  guilds.set(42, "Чужие");
  assert.equal(adapter.unitGuildName("target"), "Чужие");
  assert.equal(adapter.watchUnitAnswers("target", () => {}), undefined, "nothing pending any more");
  w.targetGuid = wolf.guid;
  assert.deepEqual(adapter.unitSummonTitle("target"), { globalName: "UNITNAME_SUMMON_TITLE1", ownerName: "Охотник" });
});

function fakeConnection() {
  const queue = [];
  let wake;
  return {
    sent: [],
    push(opcode, payload = new Uint8Array()) {
      queue.push({ opcode, payload });
      if (wake) { const resume = wake; wake = undefined; resume(queue.shift()); }
    },
    send(opcode, payload = new Uint8Array()) { this.sent.push({ opcode, payload }); },
    read() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => { wake = resolve; });
    },
    close() {},
  };
}
async function settle() {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => { setImmediate(resolve); });
}
function guildAnswer(guildId, name) {
  const writer = new PacketWriter().u32(guildId).cString(name);
  for (let rank = 0; rank < 10; rank++) writer.cString(rank === 0 ? "Глава" : "");
  return writer.u32(0).u32(0).u32(0).u32(0).u32(0).u32(1).toUint8Array();
}

test("WorldClient: the tooltip's guild query goes out once; a foreign answer leaves the player's guild slot alone", async () => {
  const connection = fakeConnection();
  connection.push(OPCODES.SMSG_LOGIN_VERIFY_WORLD, new PacketWriter().u32(0).f32(1).f32(2).f32(3).f32(0).toUint8Array());
  const client = new WorldClient(connection);
  await client.loginCharacter(0x1234n);
  await settle();
  client.state.objects.set(0x1234n, object(0x1234n, 4, { PLAYER_GUILDID: 7 }));
  client.state.selfGuid = 0x1234n;
  const sent = () => connection.sent.filter((packet) => packet.opcode === OPCODES.CMSG_GUILD_QUERY)
    .map((packet) => new PacketReader(packet.payload).u32());
  client.queryGuildName(42);
  client.queryGuildName(42);
  assert.deepEqual(sent(), [42], "asked once");
  // The tooltip may ask about our own guild too (hovering ourselves before its name came): still ours.
  client.queryGuildName(7);
  assert.deepEqual(sent(), [42, 7]);
  connection.push(OPCODES.SMSG_GUILD_QUERY_RESPONSE, guildAnswer(7, "Щит"));
  await settle();
  assert.equal(client.guildQuery?.name, "Щит", "our own guild fills the slot as before");
  assert.equal(client.guildNames.name(7), "Щит");
  let changed = 0;
  client.onGuildChanged = () => { changed++; };
  connection.push(OPCODES.SMSG_GUILD_QUERY_RESPONSE, guildAnswer(42, "Чужие"));
  await settle();
  assert.equal(client.guildNames.name(42), "Чужие");
  assert.equal(client.guildQuery?.name, "Щит", "the foreign answer did not replace our guild");
  assert.equal(changed, 0);
  client.queryGuildName(42);
  client.queryGuildName(7);
  assert.deepEqual(sent(), [42, 7], "a known guild is not asked again");
  client.close?.();
});

// L13 (04.10), 3.12: `/dbc/spells?v=17` serves, on a row with SPELL_EFFECT_SUMMON, the SummonProperties row each
// summon effect names by its EffectMiscValueB (`summonProperties`). Wow.exe 0x0061e830: Title n → TITLE<n>, 0 → no
// line, -1 or no row → the creature-type default. With no source of its own the line reads the page's spell rows
// (`game.spells` — the map LiveWorldSeam's `spell` reads); a row from an older gateway still gives no line.
test("L13 summon title: SummonProperties.Title from the v=17 spell row; 0 none, no row the default, an older row none", async () => {
  const { frameXmlSummonPropertiesTitle } = await import("../dist/code/browser/framexml/FrameXmlUnitTooltipExtras.js");
  const { game } = await import("../dist/code/browser/game/Context.js");
  // The dataset's rows (Spell.dbc + SummonProperties.dbc, read 2026-10-04).
  const totem = { id: 63, control: 1, faction: 0, title: 4, slot: 1, flags: 2 }; // Опаляющий тотем 3599
  const wolfSpirit = { id: 1161, control: 2, faction: 0, title: 1, slot: 0, flags: 18432 }; // Дух дикого волка 51533
  const mirror = { id: 1021, control: 1, faction: 0, title: 0, slot: 0, flags: 512 }; // Зеркальное изображение 58833
  assert.equal(frameXmlSummonPropertiesTitle({ startRecoveryCategory: 133, summonProperties: [totem, null, null] }, 0), 4);
  assert.equal(frameXmlSummonPropertiesTitle({ startRecoveryCategory: 0, summonProperties: [null, null, null] }, 0), -1,
    "the effect names no row: the default (0x0061e943)");
  assert.equal(frameXmlSummonPropertiesTitle({ startRecoveryCategory: 133 }, 0), undefined, "a dataset without the table");
  assert.equal(frameXmlSummonPropertiesTitle({ effects: [28, 0, 0] }, 0), undefined, "an older gateway's row");
  assert.equal(frameXmlSummonPropertiesTitle(undefined, 0), undefined);

  const templates = new Map([
    [0x1230, { found: true, name: "Волк", creatureType: 1 }],
    [0x4560, { found: true, name: "Тотем", creatureType: 11 }],
  ]);
  const hunter = object(HUNTER, 4, {});
  let next = 0xf1300004560001a0n;
  const made = (spellId, entry = 0x4560) =>
    object(next++, 3, { OBJECT_FIELD_ENTRY: entry, UNIT_FIELD_CREATEDBY: HUNTER, UNIT_CREATED_BY_SPELL: spellId });
  const units = { totem: made(3599), mirror: made(58833), wolf: made(51533, 0x1230), unnamed: made(4242), old: made(31687),
    unnamedBeast: made(4242, 0x1230) };
  const w = world([hunter, ...Object.values(units)], { names: new Map([[HUNTER, "Охотник"]]), templates });
  const saved = game.spells;
  game.spells = new Map([
    [3599, { id: 3599, effects: [28, 0, 0], startRecoveryCategory: 133, summonProperties: [totem, null, null] }],
    [58833, { id: 58833, effects: [28, 0, 0], startRecoveryCategory: 0, summonProperties: [mirror, null, null] }],
    [51533, { id: 51533, effects: [28, 0, 0], startRecoveryCategory: 133, summonProperties: [wolfSpirit, null, null] }],
    [4242, { id: 4242, effects: [6, 28, 0], startRecoveryCategory: 0, summonProperties: [null, null, null] }],
    [31687, { id: 31687, effects: [28, 0, 0] }],
  ]);
  try {
    const sources = { spellEffects: (id) => game.spells.get(id)?.effects };
    const line = (unit) => frameXmlUnitSummonTitle(w, unit, sources)?.globalName;
    assert.equal(line(units.totem), "UNITNAME_SUMMON_TITLE4", "«Тотем»");
    assert.deepEqual(frameXmlUnitSummonTitle(w, units.totem, sources), { globalName: "UNITNAME_SUMMON_TITLE4", ownerName: "Охотник" });
    assert.equal(line(units.wolf), "UNITNAME_SUMMON_TITLE1");
    assert.equal(line(units.mirror), undefined, "Title 0: no line");
    assert.equal(line(units.unnamed), "UNITNAME_SUMMON_TITLE3", "no row: the default, not a beast");
    assert.equal(line(units.unnamedBeast), "UNITNAME_SUMMON_TITLE1", "no row: the default, a beast");
    assert.equal(line(units.old), undefined, "an older gateway's row: still no guess");
    // A source of the caller's own still decides.
    assert.equal(frameXmlUnitSummonTitle(w, units.totem, { ...sources, summonPropertiesTitle: () => 2 })?.globalName,
      "UNITNAME_SUMMON_TITLE2");
  } finally {
    game.spells = saved;
  }
});

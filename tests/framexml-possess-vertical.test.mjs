import assert from "node:assert/strict";
import test, { after } from "node:test";

// 11.02-IF, MPQ-backed: the retail 3.3.5a BonusActionBarFrame.lua `PossessBar_*` and the bonus action
// bar over LiveWorldSeam and a real WorldClient while the character Mind Controls a creature —
// PossessBar_Update (IsPossessBarVisible/GetPossessInfo), BonusActionBar_OnEvent (GetBonusBarOffset 5),
// ActionButton_CalculateAction (page 1 + offset 5 = slots 121+), a press that casts from the unit, the
// cancel button (PossessButton_OnClick -> CancelUnitBuff("player", name)) and the way home. Only
// primitives read back from Lua are compared.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => chain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FRAMEXML_POSSESS_CANCEL_TEXTURE } = await import("../dist/code/browser/framexml/FrameXmlPossess.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { OPCODES } = await import("../dist/code/generated/opcodes.js");
const { PacketReader } = await import("../dist/code/protocol/index.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");
const { WorldStore } = await import("../dist/code/world/WorldStore.js");
const { WorldState } = await import("../dist/code/world/WorldState.js");
const {
  ACT_COMMAND, ACT_PASSIVE, COMMAND_ATTACK, COMMAND_FOLLOW, REACT_DEFENSIVE, packPetAction,
} = await import("../dist/code/world/PetProtocol.js");
const { game } = await import("../dist/code/browser/game/Context.js");

const decoder = new TextDecoder("utf-8");
const provider = {
  async read(path) {
    const data = await chain.read(path);
    return data ? decoder.decode(data) : undefined;
  },
};

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "possess-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const SELF = 0x10n;
const MOB = 0xf130_0000_0004_d2a0n;
const ENEMY = 0xf130_0000_0000_0077n;
const MOB_ENTRY = 1234;
const MIND_CONTROL = 605;
const FIREBALL = 20793;
const offset = (name) => UPDATE_FIELDS[name].offset;

const SPELLS = new Map([
  [MIND_CONTROL, {
    id: MIND_CONTROL, name: "Контроль над разумом", rank: "", description: "", iconPath: "Interface\\Icons\\Spell_Shadow_ShadowWordDominate",
    effectAura: [2, 4, 138], effectMiscValue: [0, 0, 0], effects: [6, 6, 6], attributes: [0x40140000, 0x4022005, 0, 0, 0, 0, 0, 0],
    channeled: true, passive: false, powerType: 0, powerCost: 0, powerCostPercent: 0,
  }],
  [FIREBALL, {
    id: FIREBALL, name: "Огненный шар", rank: "", description: "", iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt",
    effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], effects: [2, 0, 0], passive: false, powerType: 0, powerCost: 0, powerCostPercent: 0,
  }],
]);

function setGuid(object, at, guid) {
  object.fields.set(at, Number(guid & 0xffff_ffffn));
  object.fields.set(at + 1, Number(guid >> 32n));
}

function worldFixture() {
  const sent = [];
  const world = new WorldClient({ send(opcode, payload = new Uint8Array()) { sent.push({ opcode, payload }); }, close() {} });
  const state = new WorldState();
  world.state = state;
  const object = (guid, typeId, entries) => ({
    guid, typeId, position: { x: 0, y: 0, z: 0, orientation: 0 }, movementFlags: 0, updateFlags: 0, targetGuid: undefined,
    runSpeed: undefined, turnRate: undefined, motion: undefined, glide: undefined, transport: undefined,
    speeds: undefined, transportTime: undefined, fields: new Map(entries),
  });
  state.objects.set(SELF, object(SELF, 4, [
    [offset("UNIT_FIELD_BYTES_0"), 1 | (5 << 8)], [offset("UNIT_FIELD_LEVEL"), 80],
    [offset("UNIT_FIELD_HEALTH"), 4000], [offset("UNIT_FIELD_MAXHEALTH"), 4000], [offset("UNIT_FIELD_FLAGS"), 0x08],
  ]));
  state.objects.set(MOB, object(MOB, 3, [
    [offset("OBJECT_FIELD_ENTRY"), MOB_ENTRY], [offset("UNIT_FIELD_LEVEL"), 70],
    [offset("UNIT_FIELD_HEALTH"), 500], [offset("UNIT_FIELD_MAXHEALTH"), 500],
  ]));
  state.selfGuid = SELF;
  const store = new WorldStore(state);
  world.creatureTemplates.set(MOB_ENTRY, { entry: MOB_ENTRY, name: "Огр", subName: "", flags: 0, creatureType: 7 });
  world.mapId = 0;
  world.selfName = "Жрец";
  const realmTime = { minuteOfDay: 9 * 60 + 30, minutesPerSecond: 1 / 60, weekday: 4, date: { year: 2024, month: 2, day: 29 } };
  world.currentGameTime = () => realmTime;
  world.calendarPending = 0;
  world.targetGuid = ENEMY;
  return { world, store, sent, player: state.objects.get(SELF), mob: state.objects.get(MOB) };
}

const POSSESS_BAR = [
  packPetAction(COMMAND_ATTACK, ACT_COMMAND), packPetAction(FIREBALL, ACT_PASSIVE),
  ...Array.from({ length: 8 }, () => packPetAction(0, ACT_PASSIVE)),
];

test("11.02-IF: Mind Control in the stock UI — possess buttons, the unit's spells on the bonus bar, a press, the cancel, home", withClient, async () => {
  const { world, store, sent, player, mob } = worldFixture();
  const previousWorld = game.world;
  game.world = world;
  let now = 1;
  const seam = new LiveWorldSeam({
    world: () => world, store: () => store,
    spell: (id) => SPELLS.get(id) ?? { id, name: `Заклинание ${id}`, rank: "", description: "", iconPath: "Interface\\Icons\\Spell_Test", effectAura: [0, 0, 0], effectMiscValue: [0, 0, 0], passive: false },
    monotonic: () => now * 1000, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const boot = new FrameXmlBoot({
    provider, locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, screen: () => ({ width: 1365, height: 768 }),
    // 11.02-IF-review: GameTooltip:SetPossession(1) draws the possess spell through the adapter.
    gameTooltipAdapter: {
      inventoryItem: () => undefined, containerItem: () => undefined,
      spell: (id) => (SPELLS.has(id) ? { title: SPELLS.get(id).name } : undefined),
      possessionSpell: () => seam.possess.possessSpell || undefined,
    },
  });
  const failures = () => boot.errors.map((failure) => `${failure.file}:${failure.line}: ${failure.message}`)
    .concat(boot.vm.errors.map(String));
  const poll = () => { now += 0.1; seam.tick(now); };
  const frames = (count = 15) => { for (let index = 0; index < count; index += 1) boot.bridge.tick(0.02); };
  const view = () => {
    const values = lua(boot, `
      local function shown(frame) return frame:IsShown() and 1 or 0 end
      local function texture(region) return string.lower(region:GetTexture() or "") end
      return shown(PossessBarFrame), shown(PossessButton1), shown(PossessButton2),
        texture(PossessButton1Icon), texture(PossessButton2Icon),
        shown(BonusActionBarFrame), BonusActionBarFrame.state or "", BonusActionButton2.action or 0,
        texture(BonusActionButton2Icon), shown(PetActionBarFrame)`, 10);
    return {
      possessBar: values[0], possess1: values[1], possess2: values[2], icon1: values[3], icon2: values[4],
      bonusBar: values[5], bonusState: values[6], action2: values[7], bonusIcon2: values[8], petBar: values[9],
    };
  };
  try {
    await boot.load();
    const errorsAtBoot = failures();
    poll();
    frames();
    assert.deepEqual([view().possessBar, view().bonusBar], [0, 0], "no possession, no possess bar and no bonus bar");

    // Unit::SetCharmedBy(POSSESS): control, the bar, the caster's aura, then the fields.
    world.controlledGuid = MOB;
    world.petSpells = {
      guid: MOB, closed: false, creatureFamily: 0, duration: 0, reactState: REACT_DEFENSIVE, commandState: COMMAND_FOLLOW,
      flags: 0, spells: [], cooldowns: [],
      bar: POSSESS_BAR.map((packed, slot) => ({ slot, packed, action: packed & 0xffffff, type: packed >>> 24 })),
    };
    world.events.emit("PET_BAR_CHANGED", { guid: MOB });
    world.auras.set(SELF, new Map([[0, { slot: 0, spellId: MIND_CONTROL, flags: 0x18, casterLevel: 80, applications: 0 }]]));
    mob.fields.set(offset("UNIT_FIELD_FLAGS"), 0x0100_0000);
    setGuid(mob, offset("UNIT_FIELD_CHARMEDBY"), SELF);
    setGuid(player, offset("UNIT_FIELD_CHARM"), MOB);
    setGuid(player, offset("PLAYER_FARSIGHT"), MOB);
    poll();
    frames();
    assert.deepEqual(view(), {
      possessBar: 1, possess1: 1, possess2: 1,
      icon1: "interface\\icons\\spell_shadow_shadowworddominate", icon2: FRAMEXML_POSSESS_CANCEL_TEXTURE.toLowerCase(),
      bonusBar: 1, bonusState: "top", action2: 122, bonusIcon2: "interface\\icons\\spell_fire_flamebolt", petBar: 0,
    });
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error on the way in");

    // 11.02-IF-review: PossessButton_OnEnter — slot 1 through GameTooltip:SetPossession (0x006257c0), slot 2
    // (POSSESS_CANCEL_SLOT) is GameTooltip:SetText(CANCEL) in Lua.
    const hover = (button) => lua(boot, `${button}:GetScript("OnEnter")(${button})
      return GameTooltipTextLeft1:GetText(), GameTooltip:IsShown() and 1 or 0`, 2);
    assert.deepEqual(hover("PossessButton1"), ["Контроль над разумом", 1]);
    assert.deepEqual(hover("PossessButton2"), [lua(boot, "return CANCEL")[0], 1]);
    lua(boot, "GameTooltip:Hide()", 0);
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error on hover (SetPossession was a nil method)");

    // BonusActionButton2: UseAction(122) -> the pet bar's slot 2 -> CMSG_PET_CAST_SPELL from the unit.
    sent.length = 0;
    lua(boot, "BonusActionButton2:Click('LeftButton')", 0);
    const casts = sent.filter((packet) => packet.opcode === OPCODES.CMSG_PET_CAST_SPELL);
    assert.equal(casts.length, 1, `sent: ${sent.map((packet) => packet.opcode.toString(16)).join(",")}`);
    const cast = new PacketReader(casts[0].payload);
    assert.equal(cast.u64(), MOB);
    cast.u8();
    assert.equal(cast.u32(), FIREBALL);
    assert.equal(sent.some((packet) => packet.opcode === OPCODES.CMSG_CAST_SPELL), false, "not the character's own cast");

    // PossessButton2 (POSSESS_CANCEL_SLOT): UnitControllingVehicle is nil, so CancelUnitBuff("player", name).
    sent.length = 0;
    lua(boot, "PossessButton2:Click('LeftButton')", 0);
    assert.deepEqual(sent.map((packet) => [packet.opcode, ...packet.payload]),
      [[OPCODES.CMSG_CANCEL_AURA, MIND_CONTROL & 0xff, MIND_CONTROL >> 8, 0, 0]]);

    // Unit::RemoveCharmedBy: control back, the bar closed, the fields cleared.
    world.controlledGuid = SELF;
    world.petSpells = undefined;
    world.events.emit("PET_BAR_CHANGED", { guid: 0n });
    world.auras.delete(SELF);
    mob.fields.set(offset("UNIT_FIELD_FLAGS"), 0);
    setGuid(mob, offset("UNIT_FIELD_CHARMEDBY"), 0n);
    setGuid(player, offset("UNIT_FIELD_CHARM"), 0n);
    setGuid(player, offset("PLAYER_FARSIGHT"), 0n);
    poll();
    frames();
    const home = view();
    assert.deepEqual([home.possessBar, home.bonusBar, home.bonusState], [0, 0, "bottom"], "the bonus bar slid away");
    assert.deepEqual(failures(), errorsAtBoot, "no Lua error on the way home");
  } finally {
    boot.close();
    game.world = previousWorld;
  }
});

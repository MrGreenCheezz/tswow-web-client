import assert from "node:assert/strict";
import test, { after } from "node:test";

// The real Blizzard_ArenaUI from the client's MPQs, loaded on demand by the lazy owner the world mount
// publishes (FrameXmlArenaLod.ts), over the vertical corpus and the live seam with a world in an arena
// match (FrameXmlArena.ts): nothing at boot or outside an arena; UIParent's PLAYER_ENTERING_WORLD or
// the match's battlefield status loads it through the host (never stock's UIParentLoadAddOn); the
// gate runs stock ArenaEnemyFrames_UpdateVisible; stock's handlers then draw arena1… from the model.

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const skip = clientDirectory ? false : "no 3.3.5a client on this machine";

globalThis.window ??= { devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage ??= { getItem() { return null; }, setItem() {}, removeItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { FRAMEXML_ARENA_ADDON, frameXmlArenaGate, mountFrameXmlArenaEnemy } = await import(
  "../dist/code/browser/framexml/FrameXmlArenaLod.js",
);
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_arenaui/";

function lua(boot, code, count = 1) {
  const fn = boot.vm.compileFunction(code, "arena-enemy-test", []);
  assert.ok(fn, "the probe compiles");
  try { return boot.vm.call(fn, [], count); } finally { boot.vm.release(fn); }
}

async function settle(condition, rounds = 400) {
  for (let round = 0; round < rounds && !condition(); round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let sharedChain;
after(() => sharedChain?.close());

class FakeEvents {
  #listeners = new Map();
  on(name, listener) {
    const listeners = this.#listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(name, listeners);
    return () => listeners.delete(listener);
  }
  emit(name, payload) { for (const listener of [...(this.#listeners.get(name) ?? [])]) listener(payload); }
}

const bytes0 = (classId, powerType) => (1 | (classId << 8) | (powerType << 24)) >>> 0;
function unit(guid, typeId, fields = {}) {
  const object = { guid, typeId, fields: new Map() };
  for (const [name, value] of Object.entries(fields)) object.fields.set(UPDATE_FIELDS[name].offset, value);
  return object;
}

/** A player on the Alliance arena team; a mage and a hunter with a wolf on the other. */
function arenaWorld() {
  const selfGuid = 0x10n;
  const self = unit(selfGuid, 4, { PLAYER_BYTES_3: 1 << 24, UNIT_FIELD_BYTES_0: bytes0(1, 1), UNIT_FIELD_LEVEL: 80 });
  const mage = unit(0x31n, 4, { UNIT_FIELD_BYTES_0: bytes0(8, 0), UNIT_FIELD_HEALTH: 12000, UNIT_FIELD_MAXHEALTH: 16000, UNIT_FIELD_LEVEL: 80 });
  mage.fields.set(UPDATE_FIELDS.UNIT_FIELD_POWER1.offset, 9000);
  mage.fields.set(UPDATE_FIELDS.UNIT_FIELD_MAXPOWER1.offset, 20000);
  const hunter = unit(0x32n, 4, { UNIT_FIELD_BYTES_0: bytes0(3, 0), UNIT_FIELD_HEALTH: 15000, UNIT_FIELD_MAXHEALTH: 15000, UNIT_FIELD_LEVEL: 80 });
  const wolf = unit(0xf1400000000001a1n, 3, { UNIT_FIELD_BYTES_0: bytes0(1, 2), UNIT_FIELD_HEALTH: 6000, UNIT_FIELD_MAXHEALTH: 8000, UNIT_FIELD_LEVEL: 80 });
  wolf.fields.set(UPDATE_FIELDS.UNIT_FIELD_SUMMONEDBY.offset, 0x32);
  hunter.fields.set(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset, Number(wolf.guid & 0xffffffffn));
  hunter.fields.set(UPDATE_FIELDS.UNIT_FIELD_SUMMON.offset + 1, Number(wolf.guid >> 32n));
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, self]]) },
    battlefieldQueues: new Map(),
    names: new Map([[0x31n, "Ледышка"], [0x32n, "Стрелок"]]),
    casts: new Map(), events: new FakeEvents(), creatureTemplates: new Map(), partyStats: new Map(),
    group: undefined, actionButtons: [], knownSpells: [], cooldownRemaining: () => 0,
  };
  const enter = () => world.battlefieldQueues.set(0, {
    queueSlot: 0, status: 3, isArena: true, cleared: false, clientInstanceId: 3, mapId: 572, arenaType: 2,
  });
  return { world, mage, hunter, wolf, enter };
}

/** The vertical over the live seam; the add-on's files can be held, withheld or broken. */
async function stage({ barrier = false, missing = false, broken = false, inArena = false } = {}) {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = sharedChain ??= await clientArchives(clientDirectory);
  const requests = [];
  let release;
  const gate = barrier ? new Promise((resolve) => { release = resolve; }) : undefined;
  const fixture = arenaWorld();
  if (inArena) fixture.enter();
  const seam = new LiveWorldSeam({
    world: () => fixture.world, store: () => undefined, monotonic: () => 10_000,
    spell: (id) => (id === 118 ? { id, name: "Превращение", rank: "Уровень 1", iconPath: "Interface\\Icons\\Spell_Nature_Polymorph" } : undefined),
    globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalize(path);
        requests.push(key);
        if (!key.startsWith(ADDON_PREFIX)) {
          const data = await chain.read(path);
          return data ? decoder.decode(data) : undefined;
        }
        if (gate) await gate;
        if (missing) return undefined;
        const data = await chain.read(path);
        const text = data ? decoder.decode(data) : undefined;
        // An add-on that loads and then raises in its first background update: what the gate catches.
        return broken && text && key.endsWith("/blizzard_arenaui.lua")
          ? `${text}\nfunction UpdateArenaEnemyBackground() error("broken arena") end\n` : text;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false, screen: () => ({ width: 1024, height: 768 }),
  });
  let addonResult;
  const loadAddon = boot.loadAddon.bind(boot);
  boot.loadAddon = async (name) => (addonResult = await loadAddon(name));
  await boot.load();
  const roots = [];
  const renderer = { addRoots: (added) => roots.push(...added), sync() {} };
  lua(boot, `__arenaMessages = {}
    local say = message
    message = function(text, ...) __arenaMessages[#__arenaMessages + 1] = tostring(text) return say(text, ...) end`, 0);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  // 3.16: whether the native #arena-frames step aside (the body class the world mount hides them by).
  const owned = [];
  const mounted = mountFrameXmlArenaEnemy(seam, boot, renderer, (value) => owned.push(value));
  return {
    ...fixture, seam, boot, mounted, requests, roots, warnings, owned,
    addonReads: () => requests.filter((path) => path.startsWith(ADDON_PREFIX)),
    release: () => release?.(), addon: () => addonResult,
    messages: () => lua(boot, "return table.concat(__arenaMessages, '|')")[0],
    close: () => { console.warn = warn; mounted?.cleanup(); seam.detach(); boot.close(); },
  };
}

/**
 * UIParent's own PLAYER_ENTERING_WORLD (UIParent.lua:646-670), which calls Arena_LoadUI in an arena.
 * Only UIParent's: the whole corpus's handlers would also run SpellBookFrame's against this sketch
 * of a world, which has no spell tabs.
 */
const enteringWorld = (boot) => lua(boot, `UIParent:GetScript("OnEvent")(UIParent, "PLAYER_ENTERING_WORLD")`, 0);

const frames = (boot) => lua(boot, `
  local shown = {}
  for i = 1, MAX_ARENA_ENEMIES do
    local frame = _G["ArenaEnemyFrame" .. i]
    if frame:IsShown() then shown[#shown + 1] = i .. "=" .. tostring(frame.name:GetText()) end
    if frame.petFrame:IsShown() then shown[#shown + 1] = "pet" .. i end
  end
  return table.concat(shown, ",")`)[0];

test("Blizzard_ArenaUI: nothing outside an arena; the match loads it through the host and draws arena1-2 with a pet", { skip }, async () => {
  const run = await stage({ barrier: true });
  const { seam, boot, mounted, world, mage, hunter, wolf } = run;
  try {
    assert.equal(FRAMEXML_VERTICAL_TOC.some((entry) => /arenaui/i.test(entry)), false, "not in the boot corpus");
    assert.ok(mounted, "UIParent.lua's Arena_LoadUI is taken over");
    assert.equal(mounted.owner.state, "idle");
    // Stock's own PLAYER_ENTERING_WORLD outside an arena: IsInInstance says "none", nothing loads.
    enteringWorld(boot);
    seam.arena.tick();
    await settle(() => false, 5);
    assert.deepEqual(run.addonReads(), [], "outside an arena nothing is read");
    assert.equal(boot.bridge.getFrame("ArenaEnemyFrames")?.name, undefined);
    const widgets = boot.bridge.frames.length;
    const errors = boot.errorCount;

    // SMSG_BATTLEFIELD_STATUS: the arena match runs; the mage is already in sight while the files load.
    run.enter();
    world.state.objects.set(mage.guid, mage);
    seam.arena.tick();
    await settle(() => run.addonReads().length > 0);
    assert.equal(mounted.owner.state, "loading");
    assert.deepEqual(lua(boot, "return IsInInstance()", 2), [1, "arena"]);
    assert.deepEqual(lua(boot, `return LoadAddOn("${FRAMEXML_ARENA_ADDON}")`, 2), [false, "NOT_READY"]);
    // UIParent's PLAYER_ENTERING_WORLD in the arena calls Arena_LoadUI again: no dialog, no second load.
    enteringWorld(boot);
    assert.equal(run.messages(), "", "no load-error dialog while loading");
    run.release();
    await mounted.owner.settled();

    assert.equal(mounted.owner.state, "ready", run.warnings.join("\n"));
    assert.equal(run.messages(), "", "no stock message() at all");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(errors))}`);
    const result = run.addon();
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.loaded, [
      `${ADDON_PREFIX}blizzard_arenaui.toc`, `${ADDON_PREFIX}blizzard_arenaui.xml`,
      `${ADDON_PREFIX}blizzard_arenaui.lua`, `${ADDON_PREFIX}localization.lua`,
    ]);
    assert.equal(new Set(run.addonReads()).size, 4, "one load: each file read once");
    assert.ok(boot.bridge.frames.length > widgets, "the add-on's widget tree");
    assert.deepEqual(run.roots.filter((root) => root.parent === undefined), [], "every frame hangs from UIParent");
    // The client's CVar defaults, registered before OnLoad read them.
    assert.deepEqual(lua(boot, `return GetCVar("showArenaEnemyFrames"), GetCVar("showArenaEnemyCastbar"),
      GetCVar("showArenaEnemyPets"), GetCVar("partyBackgroundOpacity"), SHOW_ARENA_ENEMY_PETS`, 5), ["1", "1", "1", "0.5", "1"]);

    // The replay reached stock: arena1 is the mage, drawn by UnitFrame_Update from the live seam.
    assert.equal(frames(boot), "1=Ледышка");
    assert.deepEqual(lua(boot, `return ArenaEnemyFrames:IsShown(), GetNumArenaOpponents(),
      ArenaEnemyFrame1HealthBar:GetValue(), select(2, ArenaEnemyFrame1HealthBar:GetMinMaxValues()),
      ArenaEnemyFrame1ManaBar:GetValue(), ArenaEnemyFrame1ClassPortrait:GetTexture()`, 6).map((value) =>
      typeof value === "string" ? value.toLowerCase() : value),
    [true, 1, 12000, 16000, 9000, "interface\\targetingframe\\ui-classes-circles"]);
    // The circle's coordinates are CLASS_ICON_TCOORDS[class] (Blizzard_ArenaUI.lua:148-153).
    assert.deepEqual(lua(boot, "return select(2, UnitClass('arena1'))"), ["MAGE"]);

    // The hunter and the wolf come into sight: arena2 and its pet frame.
    world.state.objects.set(hunter.guid, hunter);
    world.state.objects.set(wolf.guid, wolf);
    seam.arena.tick();
    assert.equal(frames(boot), "1=Ледышка,2=Стрелок,pet2");
    assert.deepEqual(lua(boot, "return ArenaEnemyFrame2PetFrameHealthBar:GetValue(), GetNumArenaOpponents()", 2), [6000, 2]);

    // Damage on the mage: UNIT_HEALTH arena1 moves stock's bar.
    mage.fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 4000);
    seam.arena.tick();
    assert.deepEqual(lua(boot, "return ArenaEnemyFrame1HealthBar:GetValue()"), [4000]);

    // The mage casts Polymorph: the arena cast bar shows it.
    world.casts.set(mage.guid, { spellId: 118, startedAt: 9_000, duration: 1_500, channel: false, castCount: 4 });
    world.events.emit("SPELL_CAST_START", { casterGuid: mage.guid, spellId: 118, castTime: 1_500, channel: false });
    assert.deepEqual(lua(boot, "return ArenaEnemyFrame1CastingBar:IsShown(), ArenaEnemyFrame1CastingBarText:GetText(), ArenaEnemyFrame1CastingBar.casting", 3),
      [true, "Превращение", 1]);
    world.casts.delete(mage.guid);
    world.events.emit("SPELL_CAST_STOP", { casterGuid: mage.guid, spellId: 118, interrupted: true, reason: "interrupted" });
    assert.deepEqual(lua(boot, "return ArenaEnemyFrame1CastingBar.casting", 1), [undefined]);

    // The mage blinks out of sight: «unseen», the frame stays, locked grey, with the last health.
    world.state.objects.delete(mage.guid);
    seam.arena.tick();
    assert.equal(frames(boot), "1=Ледышка,2=Стрелок,pet2");
    // ArenaEnemyFrame_Lock (Blizzard_ArenaUI.lua:158-164) greys and locks both bars.
    assert.deepEqual(lua(boot, `return ArenaEnemyFrame1HealthBar.lockColor, ArenaEnemyFrame1ManaBar.lockColor,
      ArenaEnemyFrame1.hideStatusOnTooltip, ArenaEnemyFrame1HealthBar:GetValue(), UnitExists("arena1"), UnitGUID("arena1") ~= nil`, 6),
    [true, true, true, 4000, false, true]);

    // The match ends: every frame «cleared», and the set hides with the arena.
    world.battlefieldQueues.clear();
    seam.arena.tick();
    assert.equal(frames(boot), "");
    assert.deepEqual(lua(boot, "return ArenaEnemyFrames:IsShown(), GetNumArenaOpponents()", 2), [false, 0]);
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(errors))}`);
    assert.equal(run.messages(), "");
    assert.deepEqual(run.warnings, []);
  } finally {
    run.close();
  }
});

test("already in an arena at publish: the load starts at once and the gate passes", { skip }, async () => {
  const run = await stage({ inArena: true });
  const { mounted, boot, seam } = run;
  try {
    assert.equal(mounted.owner.state, "loading", "stock's PLAYER_ENTERING_WORLD branch: IsInInstance says arena");
    await mounted.owner.settled();
    assert.equal(mounted.owner.state, "ready", run.warnings.join("\n"));
    const gate = frameXmlArenaGate(seam, boot);
    assert.deepEqual(gate, { opponents: 0, shown: 0, visible: true });
    assert.equal(run.messages(), "");
    assert.deepEqual(run.owned, [true], "3.16: the stock enemy frames own the opponents; native steps aside");
  } finally {
    run.close();
  }
  assert.deepEqual(run.owned, [true, false], "the mount's cleanup gives the native frames back");
});

test("a failed load stays silent: no dialog, no second attempt", { skip }, async () => {
  const run = await stage({ missing: true, inArena: true });
  const { mounted, boot, seam } = run;
  try {
    await mounted.owner.settled();
    assert.equal(mounted.owner.state, "failed");
    const reads = run.addonReads().length;
    assert.ok(reads > 0);
    enteringWorld(boot);
    seam.arena.tick();
    await settle(() => false, 5);
    assert.equal(run.addonReads().length, reads, "demoted for good: nothing is read again");
    assert.equal(run.messages(), "", "no «Ошибка загрузки» dialog");
    assert.match(run.warnings.join("\n"), /Blizzard_ArenaUI/);
  } finally {
    run.close();
  }
});

test("an add-on that fails its gate is silenced: its frames stop listening and hide", { skip }, async () => {
  const run = await stage({ broken: true, inArena: true });
  const { mounted, boot, seam, world, mage } = run;
  try {
    await mounted.owner.settled();
    assert.equal(mounted.owner.state, "failed");
    assert.match(run.warnings.join("\n"), /did not pass its gate/);
    assert.deepEqual(run.owned, [false], "3.16: a failed gate leaves the native enemy frames on");
    const errors = boot.errorCount;
    world.state.objects.set(mage.guid, mage);
    seam.arena.tick();
    enteringWorld(boot);
    boot.pump.fire("ARENA_OPPONENT_UPDATE", "arena1", "seen");
    assert.equal(boot.errorCount, errors, `the broken add-on is not reached again: ${JSON.stringify(boot.errors.slice(errors))}`);
    assert.deepEqual(lua(boot, "return ArenaEnemyFrames:IsShown(), ArenaEnemyFrame1:IsShown()", 2), [false, false]);
    assert.equal(run.messages(), "");
  } finally {
    run.close();
  }
});

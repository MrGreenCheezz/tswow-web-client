// Regression: shapeshifts and mounts must replace the player's model, even though the fix itself
// is only two lines of client code.
//
// Two independent causes, one on each side of the same question — which M2 does this player wear
// right now?
//
// 1. `Frames.unitModel` pasted the character's own appearance — skin, face, hair, worn armour —
//    onto whatever display record came back, unconditionally, for every object of type 4. A druid
//    in bear form is still type 4, so the bear was handed a night elf's textures and geosets; and
//    because `Unit::SetDisplayId` rewrites the gender byte along with the model
//    (`creature_model_info`), the appearance key changed on every shift, missed the cache, went to
//    the network, and returned undefined until it came back — which is what «модель не меняется»
//    looked like on the screen. `UNIT_FIELD_NATIVEDISPLAYID` is PUBLIC and the server writes it
//    once, in `Player::InitDisplayIds`, so «this player is not in their own body» is readable here
//    for free.
// 2. `CreatureModelClient.request` marked ids as requested before asking and never unmarked them,
//    so one failed batch made a display id unobtainable for the life of the tab.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

// The same checkout the protocol generator reads (`tools/generate-protocol.mjs:6-8`), because the
// numbers a module window is told to compare against are that build's enum and nothing else.
let auraDefines;
try {
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const core = process.env.TRINITYCORE_DIR
    ?? fileURLToPath(new URL("../../tswow/cores/TrinityCore", import.meta.url));
  auraDefines = await readFile(join(core, "src/server/game/Spells/Auras/SpellAuraDefines.h"), "utf8");
} catch {
  auraDefines = undefined;
}
const withCore = { skip: auraDefines ? false : "no TrinityCore checkout on this machine" };

/** The document `self-name.test.mjs` uses: `ui/Dom.ts` resolves its handles once, at import. */
function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], dataset: {}, className: "", textContent: "",
      title: "", hidden: false, disabled: false, onerror: null, src: "", id: "", value: "", options: [],
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(" ").filter(Boolean), ...names])].join(" "); },
        remove(...names) { node.className = node.className.split(" ").filter((name) => !names.includes(name)).join(" "); },
        toggle(name, on) { if (on) this.add(name); else this.remove(name); },
        contains(name) { return node.className.split(" ").includes(name); },
      },
      append(...nodes) { node.children.push(...nodes); },
      prepend(...nodes) { node.children.unshift(...nodes); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...nodes) { node.children = [...nodes]; },
      remove() {}, focus() {}, blur() {},
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { node[name] = value; },
      getAttribute(name) { return node[name] ?? null; },
      removeAttribute(name) { delete node[name]; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (text) => ({ textContent: text }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) {
        node = make("div");
        node.id = id;
        byId.set(id, node);
      }
      return node;
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");
const { game } = await import("../dist/code/browser/game/Context.js");
const { mountModel, unitModel } = await import("../dist/code/browser/ui/Frames.js");
const { CreatureModelClient } = await import("../dist/code/browser/CreatureModelClient.js");
const { CREATURE_MODEL_VERSION, IMAGE_RETRY_BACKOFF_MS } = await import("../dist/code/browser/CharacterAtlas.js");
const { unitObjectScale } = await import("../dist/code/browser/WorldRenderer3D.js");
const { geosetList, geosetVisible, resolveGeosets, unitGeosets } =
  await import("../dist/code/browser/ModelBuild.js");
const { attachmentPoint, SHEATH_MELEE } = await import("../dist/code/browser/Attachment.js");
const { ATTACHMENT_SHIELD } = await import("../dist/code/browser/Wvm.js");
const { buildWindowSnapshot } = await import("../dist/code/browser/ui/WindowBindings.js");

/** Night elf female (race 4, sex 1), the shape a shapeshifting character actually has. */
const BYTES_0 = 4 | (1 << 16);
/** `CreatureDisplayInfo` ids measured off this dataset's TDB: the druid's own two forms. */
const NIGHT_ELF_FEMALE = 20;
const BEAR_FORM = 2281;

/**
 * A record shaped the way `isMetadata` demands, so the client accepts it off the wire.
 *
 * `mountHeight` is part of that shape from П2 on: 917 of the 1,331 rows of `CreatureModelData`
 * carry a zero here and it is a real answer, so the guard checks the number and not its sign.
 */
function record(id, model, appearance, mountHeight = 0) {
  return {
    id, model, scale: 1, collisionHeight: 2.03, mountHeight, textures: "",
    ...(appearance ? { appearance } : {}),
  };
}

/** One player object, wearing `displayId` while its body is `nativeDisplayId`. */
function player(displayId, nativeDisplayId) {
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset, displayId);
  if (nativeDisplayId !== undefined) fields.set(UPDATE_FIELDS.UNIT_FIELD_NATIVEDISPLAYID.offset, nativeDisplayId);
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, BYTES_0);
  fields.set(UPDATE_FIELDS.PLAYER_BYTES.offset, 0);
  fields.set(UPDATE_FIELDS.PLAYER_BYTES_2.offset, 0);
  return { guid: 0x1234n, typeId: 4, fields, position: { x: 0, y: 0, z: 0, orientation: 0 } };
}

/**
 * What the gateway emits for a bare night elf female, measured: geoset 0 the torso, 401 the hands,
 * 501 the shins, 702 the ears, 1301 the thighs, 1501 the collar (`ModelBuild.defaultCharacterGeosets`).
 * A dressed character sends the same six families with other variants.
 */
const PLAYER_GEOSETS = [0, 401, 501, 702, 1301, 1501];

/** A creature-model stand-in that records every appearance lookup it is asked for. */
function models(records, attached = []) {
  const asked = [];
  game.creatureModels = {
    get: (id) => records.get(id),
    playerAppearance: (...args) => {
      asked.push(args);
      return { race: 4, sex: 1, textures: [], geosets: PLAYER_GEOSETS, hair: "", attached };
    },
    request() {},
  };
  return asked;
}

test("Ж0 a shapeshifted player wears the form's own record, not the character's face", () => {
  const records = new Map([
    [BEAR_FORM, record(BEAR_FORM, "Creature\\Bear\\Bear.m2")],
    [NIGHT_ELF_FEMALE, record(NIGHT_ELF_FEMALE, "Character\\NightElf\\Female\\NightElfFemale.m2")],
  ]);
  const asked = models(records);

  const bear = unitModel(player(BEAR_FORM, NIGHT_ELF_FEMALE));
  assert.equal(bear, records.get(BEAR_FORM), "the gateway's record itself, not a copy with a face on it");
  assert.equal(bear.appearance, undefined, "a bear has no hairstyle");
  assert.deepEqual(asked, [], "and no appearance is composed, so nothing waits on the network");
});

test("Ж0 a polymorph into another race keeps the appearance the gateway baked", () => {
  // The guard is worth more than it looks: the gateway puts a baked appearance on every display
  // record whose model lives under `Character\` (`CreatureModelMetadata.ts:103-105` →
  // `CharacterAppearance.forModel`), which is what a polymorph into another race is. Overwriting
  // it with the caster's own look was throwing away the right answer for the wrong one.
  const baked = { race: 1, sex: 0, textures: ["human"], geosets: [], hair: "" };
  const HUMAN_MALE = 49;
  const records = new Map([[HUMAN_MALE, record(HUMAN_MALE, "Character\\Human\\Male\\HumanMale.m2", baked)]]);
  const asked = models(records);

  const polymorphed = unitModel(player(HUMAN_MALE, NIGHT_ELF_FEMALE));
  assert.equal(polymorphed.appearance, baked, "the record arrives whole");
  assert.deepEqual(asked, []);
});

test("Ж0 a player in their own body is still dressed from their own bytes", () => {
  // The regression half. Nothing about the ordinary case may change: a character standing in their
  // own skin still has skin, face, hair and armour resolved from the update fields.
  const records = new Map([[NIGHT_ELF_FEMALE, record(NIGHT_ELF_FEMALE, "Character\\NightElf\\Female\\NightElfFemale.m2")]]);
  const asked = models(records);

  const own = unitModel(player(NIGHT_ELF_FEMALE, NIGHT_ELF_FEMALE));
  assert.equal(asked.length, 1, "the appearance is composed exactly once");
  assert.deepEqual(asked[0].slice(0, 2), [4, 1], "race and sex off UNIT_FIELD_BYTES_0");
  assert.equal(own.appearance?.race, 4);

  // And a unit whose NATIVEDISPLAYID has not arrived yet — a create block that predates the field,
  // a creature — is treated as being in its own body rather than as being shapeshifted.
  const silent = unitModel(player(NIGHT_ELF_FEMALE, undefined));
  assert.equal(asked.length, 2);
  assert.equal(silent.appearance?.race, 4);
});

test("Ж0 a creature model batch that failed is asked for again, three times, then left alone", async () => {
  // Before this the ids went into `#requested` before the fetch and never came out: one 500 from a
  // gateway still building its index and `get(2281)` answered undefined for the life of the tab, so
  // `unitModel` did too — and `#drawUnit` leaves the node alone when it gets undefined, which is
  // precisely «превращение не наступает вообще». Same ladder as a texture and a look.
  const asked = [];
  let answer = { ok: false, status: 500 };
  const original = globalThis.fetch;
  const clock = { now: 1_000 };
  const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve)); };
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (!answer.ok) return answer;
    return { ok: true, json: async () => [record(BEAR_FORM, "Creature\\Bear\\Bear.m2")] };
  };
  try {
    const client = new CreatureModelClient("ws://127.0.0.1:8090/world", () => clock.now);
    client.request(BEAR_FORM);
    await settle();
    assert.equal(asked.length, 1);
    assert.equal(client.get(BEAR_FORM), undefined);

    // Inside the first wait nothing goes out, which is what stops a request per frame.
    clock.now = 1_000 + IMAGE_RETRY_BACKOFF_MS[0] - 1;
    client.request(BEAR_FORM);
    await settle();
    assert.equal(asked.length, 1, "the wait is a wait");

    let at = 1_000;
    for (const [index, wait] of IMAGE_RETRY_BACKOFF_MS.entries()) {
      at += wait;
      clock.now = at;
      client.request(BEAR_FORM);
      await settle();
      assert.equal(asked.length, index + 2, `retry ${index + 1} went out after ${wait} ms`);
    }

    // Four attempts in all — the first plus three retries — and then silence however long the
    // session runs, because a route that has answered 500 four times over forty seconds is down.
    clock.now = at + 86_400_000;
    client.request(BEAR_FORM);
    await settle();
    assert.equal(asked.length, IMAGE_RETRY_BACKOFF_MS.length + 1, "and then it is left alone");

    // A record that does arrive clears the ledger: the id is cached, and asking again is free.
    const fresh = new CreatureModelClient("ws://127.0.0.1:8090/world", () => clock.now);
    answer = { ok: true };
    const before = asked.length;
    fresh.request(BEAR_FORM);
    await settle();
    assert.equal(asked.length, before + 1);
    assert.equal(fresh.get(BEAR_FORM)?.model, "Creature\\Bear\\Bear.m2");
    fresh.request(BEAR_FORM);
    await settle();
    assert.equal(asked.length, before + 1, "a display id that arrived is never asked for twice");
  } finally {
    globalThis.fetch = original;
    game.creatureModels = undefined;
  }
});

/* ---------------------------------------------------------------------------------------------
 * П1 — what was left once the guard and the retry ladder were in
 * ------------------------------------------------------------------------------------------- */

/**
 * `Creature\SpiritofRedemption\SpiritOfRedemption.m2` as this client ships it, measured through
 * `parseM2` over the MPQ chain: five submeshes, three of them with triangles, on geosets 0, 3 and
 * 1502. It is display 16031 — the shape a priest's Spirit of Redemption puts a *player* into, so
 * every one of the three is a submesh the player's own geoset list has an opinion about.
 */
const SPIRIT_OF_REDEMPTION = 16031;
const SPIRIT_SUBMESHES = [{ geosetId: 3, triangles: 100 }, { geosetId: 0, triangles: 1164 }, { geosetId: 1502, triangles: 117 }];

/** What `buildModel` draws for one appearance: resolve the asked-for list, then filter. */
function drawn(appearance, submeshes) {
  const present = new Set(submeshes.map((submesh) => submesh.geosetId));
  // `isCharacter` is the model's own type 1 body slot, and SpiritOfRedemption has none — its only
  // texture slot is type 0, measured. So with no appearance it is EVERY_GEOSET, as authored.
  const { choice } = resolveGeosets(unitGeosets(appearance, false), present);
  const kept = submeshes.filter((submesh) => geosetVisible(submesh.geosetId, choice));
  return { geosets: kept.length, triangles: kept.reduce((sum, submesh) => sum + submesh.triangles, 0) };
}

test("П1 a form model draws every geoset it authored, and the player's list would take two away", () => {
  // The Ж0.3 guard is what makes this true, and this is the half of it that is geometry rather
  // than texture: pasting the character's own appearance onto the form's record does not merely
  // paint a night elf on it, it hands `unitGeosets` an explicit list, and an explicit list hides
  // everything not on it. Measured over the client's own files: SpiritOfRedemption 1 381 triangles
  // in three geosets falls to 1 164 in one (−217), DruidOwlBearTauren 980 in two falls to 914 in
  // one (−66). Those are the only two of the 25 hardcoded form displays that lose anything.
  const records = new Map([[SPIRIT_OF_REDEMPTION, record(SPIRIT_OF_REDEMPTION, "Creature\\SpiritofRedemption\\SpiritOfRedemption.m2")]]);
  const asked = models(records);

  const metadata = unitModel(player(SPIRIT_OF_REDEMPTION, NIGHT_ELF_FEMALE));
  assert.deepEqual(asked, [], "a spirit is not dressed from the player's bytes");
  assert.deepEqual(drawn(metadata.appearance, SPIRIT_SUBMESHES), { geosets: 3, triangles: 1381 });

  // And what the guard prevents, spelled out rather than described: the same model with the
  // player's own list on it. Remove the `nativeDisplayId` line from `Frames.unitModel` and the
  // assertion above becomes this one.
  const asPlayer = { race: 4, sex: 1, textures: [], geosets: PLAYER_GEOSETS, hair: "" };
  assert.deepEqual(drawn(asPlayer, SPIRIT_SUBMESHES), { geosets: 1, triangles: 1164 });

  // `SkeletonNaked` (9784) is the third display the plan named, at −510 of 1 156. Re-measured
  // through `resolveGeosets`, which `buildModel:514` runs before it filters, it loses nothing:
  // its 401/501/1301 are exactly the ids the naked list asks for, and a *dressed* list's 402, 502
  // and 1302 resolve back onto them by the reference client's rule (`ModelBuild.ts:192-206`).
  const skeleton = [
    { geosetId: 0, triangles: 646 }, { geosetId: 401, triangles: 142 },
    { geosetId: 501, triangles: 108 }, { geosetId: 1301, triangles: 260 },
  ];
  const dressed = { race: 4, sex: 1, textures: [], geosets: [0, 402, 502, 702, 1302, 1501], hair: "" };
  assert.deepEqual(drawn(undefined, skeleton), { geosets: 4, triangles: 1156 });
  assert.deepEqual(drawn(dressed, skeleton), { geosets: 4, triangles: 1156 });
  // Without the resolution step it would be the plan's −510, and that is the number to distrust.
  const raw = skeleton.filter((submesh) => geosetVisible(submesh.geosetId, geosetList(dressed.geosets)));
  assert.equal(raw.reduce((sum, submesh) => sum + submesh.triangles, 0), 646);

  game.creatureModels = undefined;
});

test("П1 a shapeshifted player has no equipment to hang, and a shield's point is the cat's", () => {
  // 10 of the 25 display ids `Unit::GetModelForForm` can hardcode carry attachment point 0 —
  // DruidCat and DruidCatTauren, both of them using it for something that is not a shield — and 21
  // of the 25 carry at least one equipment point, measured through `parseM2Skeleton` over the MPQ
  // chain. So «щит на кошке» was never a mis-parse: point 0 is really there and a shield really
  // asks for it.
  assert.equal(ATTACHMENT_SHIELD, 0);
  const shield = { slot: 16, inventoryType: 14, side: "left", model: "Item\\ObjectComponents\\Shield\\S.m2", texture: "" };
  assert.equal(attachmentPoint(shield, SHEATH_MELEE), ATTACHMENT_SHIELD);

  // What stops it is that a shapeshifted player has no appearance at all, so
  // `#updateAttachments` reads `metadata.appearance?.attached` as undefined and takes everything
  // off. The regression is on that: a bear's record must arrive bare.
  const records = new Map([
    [BEAR_FORM, record(BEAR_FORM, "Creature\\DruidBear\\DruidBear.m2")],
    [NIGHT_ELF_FEMALE, record(NIGHT_ELF_FEMALE, "Character\\NightElf\\Female\\NightElfFemale.m2")],
  ]);
  models(records, [shield]);
  assert.equal(unitModel(player(BEAR_FORM, NIGHT_ELF_FEMALE)).appearance?.attached, undefined);
  assert.deepEqual(unitModel(player(NIGHT_ELF_FEMALE, NIGHT_ELF_FEMALE)).appearance.attached, [shield],
    "and a player in their own body still carries it");

  // The other half is the gateway's, and it is why the guard is enough on its own: a polymorph
  // into another race is a `Character\` model, so the record comes with a *baked* appearance —
  // built by `CharacterAppearance.forModel:941-950` from race and sex with no equipment at all.
  const baked = { race: 1, sex: 0, textures: ["human"], geosets: [0], hair: "", attached: [] };
  const HUMAN_MALE = 49;
  models(new Map([[HUMAN_MALE, record(HUMAN_MALE, "Character\\Human\\Male\\HumanMale.m2", baked)]]), [shield]);
  assert.deepEqual(unitModel(player(HUMAN_MALE, NIGHT_ELF_FEMALE)).appearance.attached, []);

  game.creatureModels = undefined;
});

test("П1 the size on the wire is read, and clamped where the core clamps it", () => {
  // `OBJECT_FIELD_SCALE_X` had two readers in this client and neither was a unit, so every
  // creature was drawn at `CreatureDisplayInfo.CreatureModelScale` alone. Measured on this
  // dataset: 78 of 29 923 `creature_template` rows carry a scale other than 1 (0,40…9,86), 39 of
  // the 40 rows of `CreatureFamily.dbc` carry `MinScale > 0` — `MinScale` 0,30…1,00 and `MaxScale`
  // 0,50…1,40, two columns and two ranges — and 527 of 49 842 rows of `Spell.dbc` carry
  // SPELL_AURA_MOD_SCALE (61, in 517 effect slots) or SPELL_AURA_MOD_SCALE_2 (239, in 10). The
  // test below this one re-derives all four of those numbers from the DBCs themselves.
  const scaled = (typeId, value) => {
    const fields = new Map();
    if (value !== undefined) {
      const raw = new DataView(new ArrayBuffer(4));
      raw.setFloat32(0, value, true);
      fields.set(UPDATE_FIELDS.OBJECT_FIELD_SCALE_X.offset, raw.getUint32(0, true));
    }
    return unitObjectScale({ guid: 1n, typeId, fields });
  };

  // `Math.fround` because the wire word is a float32 and `fieldFloat` hands back what it decodes:
  // 9,86 comes back as 9.859999656677246 and pretending otherwise would be a rounded assertion.
  assert.equal(scaled(3, 9.86), Math.fround(9.86), "the largest scale in creature_template, and no ceiling clips it");
  assert.equal(scaled(3, 0.4), Math.fround(0.4));
  assert.equal(scaled(4, 0.5), 0.5);

  // `Unit::RecalculateObjectScale` (`Unit.cpp:11127-11133`): `scaleMin = TYPEID_PLAYER ? 0.1 : 0.01`.
  assert.equal(scaled(4, 0.05), 0.1, "a player never shrinks below a tenth");
  assert.equal(scaled(3, 0.005), 0.01, "and a creature never below a hundredth");
  // Not the game object's clamp, which is the one already in this file: 0,05…40 would have raised
  // this to 0.05 and cut a 9,86 boss down to 40 — the second only in theory, the first in practice.
  assert.equal(scaled(3, 0.02), Math.fround(0.02));

  // A field that has not arrived is one, and so is a zero: the server writes a real scale for
  // everything, and 0 is a word that has not been sent rather than a unit of no size.
  assert.equal(scaled(3, undefined), 1);
  assert.equal(scaled(3, 0), 1);
  assert.equal(scaled(4, undefined), 1);
});

/**
 * The paragraph over `unitObjectScale`, which is where both wrong numbers were written down.
 *
 * Unwrapped to one line, so that the assertions below are about the sentences and not about where
 * the eighty-column wrap happens to fall.
 */
async function scaleComment() {
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const start = source.indexOf("How large the server says this unit is");
  const end = source.indexOf("export function unitObjectScale", start);
  assert.ok(start >= 0 && end > start, "the comment over unitObjectScale has to be findable");
  return source.slice(start, end).replace(/\s*\n\s*\*\s?/g, " ");
}

test("П1 the scale paragraph names the aura the core names, and the count that goes with it", async () => {
  // Two reviews caught the same pair, so it is pinned rather than left in prose. 231 is
  // `SPELL_AURA_PROC_TRIGGER_SPELL_WITH_VALUE` (`SpellAuraDefines.h:311`) and matches 24 rows —
  // which is exactly the «(231, в 24)» that was written; the second scale aura is
  // `SPELL_AURA_MOD_SCALE_2` = 239 (`:319`) and matches 10, so the union with aura 61 is 527 and
  // not 541. The other pair: `MinScale` and `MaxScale` are two columns, and 1,40 belongs to the
  // second (family 8) — writing «0,30…1,40» as one range gave `MinScale` a top it does not have.
  const comment = await scaleComment();
  assert.match(comment, /`SPELL_AURA_MOD_SCALE_2` \(239, in 10\)/);
  assert.match(comment, /527 of 49 842 rows of `Spell\.dbc`/);
  assert.match(comment, /`MinScale` 0,30…1,00, `MaxScale` 0,50…1,40/);
  assert.doesNotMatch(comment, /\b231\b/, "231 is a proc trigger with value, not the second scale slot");
  assert.doesNotMatch(comment, /\b541\b/, "541 counted those 24 proc triggers as scale auras");
  // And the claim the numbers were carrying: not *every* hunter pet, because a pet at or past
  // `MaxScaleLevel` is drawn at `MaxScale` flat and seven families put exactly 1,0 there.
  assert.doesNotMatch(comment, /\*every\* hunter/);
  assert.match(comment, /seven hunter families carry exactly 1,0 there/);
});

test("П1 local scale aura columns match the wire layout independently of dataset size", withDataset, async (t) => {
  // The paragraph above records a historical stock census. Modules can add spells; compare
  // the named reader to the raw 3.3.5 layout instead of requiring that historical population.
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const spell = await openDbcFile(dbcDirectory, "Spell");
  const slots = (wanted) => {
    let rows = 0;
    let effects = 0;
    for (const row of spell.rows()) {
      let any = false;
      for (let slot = 0; slot < 3; slot++) {
        if (spell.int(row, "EffectAura", slot) === wanted) { effects++; any = true; }
      }
      if (any) rows++;
    }
    return { rows, effects };
  };
  const raw = await readFile(`${dbcDirectory}/Spell.dbc`);
  assert.equal(raw.readUInt32LE(8), 234);
  assert.equal(raw.readUInt32LE(12), 936);
  for (const aura of [61, 239, 231]) {
    let rows = 0;
    let effects = 0;
    for (let row = 0; row < raw.readUInt32LE(4); row++) {
      let found = false;
      for (let slot = 0; slot < 3; slot++) {
        if (raw.readUInt32LE(20 + row * 936 + (95 + slot) * 4) === aura) {
          effects++; found = true;
        }
      }
      if (found) rows++;
    }
    assert.deepEqual(slots(aura), { rows, effects }, `EffectAura ${aura} raw-column census`);
    assert.ok(rows > 0, `the local corpus exercises aura ${aura}`);
    t.diagnostic(`aura ${aura}: ${rows} rows / ${effects} effects in ${spell.records} spells`);
  }

  const family = await openDbcFile(dbcDirectory, "CreatureFamily");
  const round = (value) => Math.round(value * 100) / 100;
  const scaled = [];
  for (const row of family.rows()) {
    const min = round(family.float(row, "MinScale"));
    if (min <= 0) continue;
    scaled.push({
      id: family.id(row), min, max: round(family.float(row, "MaxScale")),
      maxLevel: family.int(row, "MaxScaleLevel"),
      // `Pet::GetNativeObjectScale` (`Pet.cpp:2010-2027`) reads this table only under
      // `getPetType() == HUNTER_PET`, and the seven rows with no diet at all are precisely the
      // warlock and death-knight families (15, 16, 17, 19, 23, 29, 40) it therefore never reaches.
      hunter: family.int(row, "PetFoodMask") !== 0,
    });
  }
  assert.equal(family.records, 40);
  assert.equal(scaled.length, 39);
  assert.deepEqual(
    [Math.min(...scaled.map((f) => f.min)), Math.max(...scaled.map((f) => f.min))], [0.3, 1],
    "MinScale is 0,30…1,00 — the 1,40 in the old comment came from the column next to it");
  assert.deepEqual(
    [Math.min(...scaled.map((f) => f.max)), Math.max(...scaled.map((f) => f.max))], [0.5, 1.4]);
  assert.equal(scaled.find((f) => f.max === 1.4).id, 8, "the crab is the only 1,40");

  // The seven that were already the right size: at or past `MaxScaleLevel` the core returns
  // `MaxScale` flat, and for these it is exactly the 1,0 this client was drawing them at.
  const alreadyRight = scaled.filter((f) => f.hunter && f.max === 1);
  assert.deepEqual(alreadyRight.map((f) => f.id), [1, 4, 5, 9, 20, 41, 42]);
  assert.deepEqual([...new Set(alreadyRight.map((f) => f.maxLevel))], [60]);
  assert.equal(scaled.filter((f) => !f.hunter).length, 7);

  // The README's example, measured rather than guessed: a wind serpent drawn at 1,0 is twice its
  // size at level 1 and 1,43 times it from 60, never three times. Three times is the devilsaur.
  const serpent = scaled.find((f) => f.id === 27);
  assert.deepEqual([serpent.min, serpent.max], [0.5, 0.7]);
  assert.equal(round(1 / serpent.min), 2);
  assert.equal(round(1 / serpent.max), 1.43);
  assert.equal(round(1 / scaled.find((f) => f.id === 39).min), 3.33, "the devilsaur, at level 1");
});

test("П1 the drawn unit is scaled by it, and its name plate moves with it", async () => {
  // `#drawUnit` needs a WebGL context, so the wiring is read off the source: the product of the
  // display record's scale and the wire's, applied to the node the model hangs in, with `height`
  // — which is where `unitHeight` puts a name plate and `#bodyHeight` puts the camera — moved by
  // the same factor. The capsule branch must stay out of it: `Creature::SetObjectScale`
  // (`Creature.cpp:3448-3457`) already multiplies BOUNDINGRADIUS and COMBATREACH by this number
  // before sending them, and the pill is built from those two.
  const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  const draw = source.indexOf("#drawUnit(");
  const drawnText = "const drawn = metadata.scale * currentObjectScale;";
  const guard = source.lastIndexOf("if (unit.applied === key)", source.indexOf(drawnText, draw));
  const guardEnd = source.indexOf("    } else {", guard);
  const guardedModel = source.slice(guard, guardEnd);
  const scaleRead = guardedModel.indexOf("currentObjectScale = unitObjectScale(object);");
  const applied = guardedModel.indexOf(drawnText, scaleRead);
  assert.ok(draw >= 0 && guard > draw && guardEnd > guard && scaleRead >= 0 && applied > scaleRead,
    "the wire scale is read and applied inside the model guard");
  assert.match(guardedModel,
    /currentObjectScale = unitObjectScale\(object\);\s*(?:(?:\/\/[^\r\n]*(?:\r?\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*const drawn = metadata\.scale \* currentObjectScale;/,
    "the drawn scale immediately uses the freshly read wire scale");
  const appliedInSource = guard + applied;
  const block = source.slice(appliedInSource, source.indexOf("} else {", appliedInSource));
  assert.match(block, /unit\.height = \(unit\.height \/ unit\.scale\) \* drawn/);
  assert.match(block, /unit\.node\.scale\.setScalar\(drawn\)/);
});

test("П1 a module window can ask which shape a unit is in", () => {
  // `Fields.unit.shapeshiftForm` was declared and read by nobody. `displayId` is not the same
  // question: it moves for a polymorph and a costume as well, and the eight cat forms are eight
  // ids for one form.
  const fields = new Map();
  fields.set(UPDATE_FIELDS.UNIT_FIELD_HEALTH.offset, 100);
  // Byte 3 of UNIT_FIELD_BYTES_2, which is where `ShapeshiftForm` lives. 5 is FORM_BEAR.
  fields.set(UPDATE_FIELDS.UNIT_FIELD_BYTES_2.offset, 5 << 24);
  const view = buildWindowSnapshot({ self: { guid: 7n, typeId: 4, fields }, selfName: "Тестий" });
  assert.equal(view.player.shapeshiftForm, 5);

  const bare = buildWindowSnapshot({ self: { guid: 7n, typeId: 4, fields: new Map() } });
  assert.equal(bare.player.shapeshiftForm, undefined, "a byte that has not arrived is not form 0");
  assert.equal(buildWindowSnapshot({}).player.shapeshiftForm, undefined);
});

test("П1 the legend over that binding is the core's own ShapeshiftForm", withCore, async () => {
  // The comment over `readonly shapeshiftForm` is the only description a module author has of what
  // this number means, and the first version of it was wrong in five entries out of eight — 8 was
  // called aquatic (it is FORM_DIREBEAR), 16 moonkin (FORM_GHOSTWOLF), 29 tree (FORM_FLIGHT). All
  // five wrong numbers are real forms, so `target.shapeshiftForm == 29` for a tree of life shows a
  // flight form rather than nothing, and no symptom names the cause. Checked against the header
  // instead of against a copy of it.
  const block = /enum ShapeshiftForm\s*\{([\s\S]*?)\}/.exec(auraDefines);
  assert.ok(block, "SpellAuraDefines.h has to carry the enum this client is generated against");
  const forms = new Map();
  for (const [, name, value] of block[1].matchAll(/FORM_(\w+)\s*=\s*(0x[0-9A-Fa-f]+|\d+)/g)) {
    forms.set(name, Number(value));
  }

  const source = await readFile(new URL("../src/browser/ui/WindowBindings.ts", import.meta.url), "utf8");
  const at = source.indexOf("`UNIT_FIELD_BYTES_2` byte 3");
  const comment = source.slice(at, source.indexOf("readonly shapeshiftForm", at))
    .replace(/\s*\n\s*\*\s?/g, " ");
  const legend = /: (1 cat[^.]*)\./.exec(comment);
  assert.ok(legend, "the legend still has to start at «1 cat» and end at the sentence's stop");

  // Every label in the legend, spelled as the enum spells it. A label this map does not carry is
  // a new entry nobody checked, and the walk below fails on it rather than skipping it.
  const spelled = new Map(Object.entries({
    cat: "CAT", tree: "TREE", travel: "TRAVEL", aquatic: "AQUA", bear: "BEAR",
    "dire bear": "DIREBEAR", "ghost wolf": "GHOSTWOLF", "flight (epic)": "FLIGHT_EPIC",
    flight: "FLIGHT", moonkin: "MOONKIN",
  }));
  const entries = legend[1].split(", ");
  assert.equal(entries.length, spelled.size);
  for (const entry of entries) {
    const parsed = /^(\d+) (.+)$/.exec(entry);
    assert.ok(parsed, `«${entry}» is not «<number> <name>»`);
    const name = spelled.get(parsed[2]);
    assert.ok(name, `«${parsed[2]}» is not one of the forms this test knows how to check`);
    assert.equal(Number(parsed[1]), forms.get(name), `${parsed[2]} is FORM_${name}`);
  }
});

/* ---------------------------------------------------------------------------------------------
 * П2 — the second model under a rider
 * ------------------------------------------------------------------------------------------- */

/** `Creature\RidingHorse\RidingHorse.m2`, display 2404: model 216, MountHeight 1.8657. */
const RIDING_HORSE = 2404;

/** One unit riding `mountDisplayId`, or riding nothing when it is left out. */
function rider(mountDisplayId, typeId = 4) {
  const object = player(NIGHT_ELF_FEMALE, NIGHT_ELF_FEMALE);
  object.typeId = typeId;
  if (mountDisplayId !== undefined) {
    object.fields.set(UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset, mountDisplayId);
  }
  return object;
}

test("П2 the mount is its own display record, read from the field that had no readers", () => {
  const records = new Map([
    [RIDING_HORSE, record(RIDING_HORSE, "Creature\\RidingHorse\\RidingHorse.m2", undefined, 1.8657)],
    [NIGHT_ELF_FEMALE, record(NIGHT_ELF_FEMALE, "Character\\NightElf\\Female\\NightElfFemale.m2")],
  ]);
  const asked = models(records);

  const horse = mountModel(rider(RIDING_HORSE));
  assert.equal(horse, records.get(RIDING_HORSE), "the gateway's own record for the mount display");
  assert.equal(horse.mountHeight, 1.8657, "and it carries the seat, which is what П2 added to the route");
  assert.deepEqual(asked, [], "a horse is a creature: no player appearance is composed for it");

  // `Unit::Mount` (`Unit.cpp:8668-8673`) writes only this field, so it is the only thing that says
  // a unit is riding — and a zero is how the wire says it is not. `#updateMount` drops the mount on
  // exactly this answer, which is the whole of dismounting: `SMSG_DISMOUNT` carries no display id.
  assert.equal(mountModel(rider(0)), undefined, "zero is dismounted");
  assert.equal(mountModel(rider(undefined)), undefined, "and a field that never arrived is too");

  // A creature can be mounted as well — `Unit::Mount` is on Unit, not on Player — and a taxi
  // gryphon comes through this same field from `WorldSession::SendDoFlight`.
  assert.equal(mountModel(rider(RIDING_HORSE, 3)), records.get(RIDING_HORSE));

  // A display id the gateway has not answered yet leaves the rider on foot for a frame rather than
  // putting them on a horse-shaped hole.
  assert.equal(mountModel(rider(30001)), undefined);
  game.creatureModels = undefined;
});

test("П2 a record with no seat is refused, which is what the version bump is for", async () => {
  // `mountHeight` is required by `isMetadata` from this slice on, so a gateway that has not been
  // redeployed answers records the browser will not take — and with `max-age=3600` on the route and
  // one request per id per session, an unbumped `CREATURE_MODEL_VERSION` would mean an hour of
  // every unit standing as a capsule. The bump is the fix, and this is the mutation that shows it
  // is needed: strip the field and nothing arrives.
  const original = globalThis.fetch;
  const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise((resolve) => setImmediate(resolve)); };
  let asked = "";
  let payload = [record(RIDING_HORSE, "Creature\\RidingHorse\\RidingHorse.m2", undefined, 1.8657)];
  globalThis.fetch = async (url) => {
    asked = String(url);
    return { ok: true, json: async () => payload };
  };
  try {
    const client = new CreatureModelClient("ws://127.0.0.1:8090/world");
    client.request(RIDING_HORSE);
    await settle();
    // 8 was the last shape without the neutral belt in NPC appearances, so 9 published that belt.
    // 10 publishes the measured worn-boot profile in the same cached creature payload. 11 adds
    // the baked NPC's authoritative body-item columns; 12 marks coordinated visual policy. 13 is
    // HD-1: `forNpc` builds through `forPlayer`, so every unbaked character display in this payload
    // gains the coordinated pack's family-20 foot and its re-extracted body layers.
    const version = Number(/[?&]v=(\d+)[&$]/.exec(asked)?.[1]);
    assert.equal(CREATURE_MODEL_VERSION, 13,
      "13 carries the coordinated pack's foot mesh and re-extracted rows into creature payloads");
    assert.equal(version, CREATURE_MODEL_VERSION, `the creature route uses the current cache-buster: v=${version}`);
    assert.equal(client.get(RIDING_HORSE)?.mountHeight, 1.8657);

    const { mountHeight, ...withoutSeat } = payload[0];
    assert.equal(mountHeight, 1.8657);
    payload = [withoutSeat];
    const stale = new CreatureModelClient("ws://127.0.0.1:8090/world");
    stale.request(RIDING_HORSE);
    await settle();
    assert.equal(stale.get(RIDING_HORSE), undefined, "a pre-П2 answer is not a creature model");
  } finally {
    globalThis.fetch = original;
    game.creatureModels = undefined;
  }
});

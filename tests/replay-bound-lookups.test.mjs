import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import * as THREE from "three";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";

function fakeDocument() {
  const byId = new Map();
  const make = () => {
    const node = {
      children: [], dataset: {}, style: { setProperty() {}, removeProperty() {} }, className: "",
      value: "", textContent: "", title: "", hidden: false, disabled: false,
      append(...children) { node.children.push(...children); },
      prepend(...children) { node.children.unshift(...children); },
      appendChild(child) { node.children.push(child); return child; },
      replaceChildren(...children) { node.children = children; },
      addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, remove() {},
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      querySelector() { return make(); }, querySelectorAll() { return []; }, closest() { return undefined; },
      getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
      getContext() { return null; },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
    return node;
  };
  return {
    createElement: make,
    createElementNS: (_namespace, _tag) => make(),
    createTextNode: (text) => ({ textContent: text }),
    createDocumentFragment: make,
    body: make(), documentElement: make(), head: make(),
    getElementById(id) {
      let node = byId.get(id);
      if (!node) { node = make(); byId.set(id, node); }
      return node;
    },
    querySelector() { return make(); }, querySelectorAll() { return []; },
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

const { game } = await import("../dist/code/browser/game/Context.js");
const { mountModel, mountModelFor, unitModel, unitModelFor, visibleEquipment, visibleEquipmentFor } =
  await import("../dist/code/browser/ui/Frames.js");
const { reactionBetween } = await import("../dist/code/browser/game/Targeting.js");
const { selectionRingColour, selectionRingColourFor } = await import("../dist/code/browser/ui/NamePlates.js");

function unit(fields) {
  return { guid: 1n, typeId: 4, fields: new Map(fields) };
}

const displayId = UPDATE_FIELDS.UNIT_FIELD_DISPLAYID.offset;
const nativeDisplayId = UPDATE_FIELDS.UNIT_FIELD_NATIVEDISPLAYID.offset;
const factionId = UPDATE_FIELDS.UNIT_FIELD_FACTIONTEMPLATE.offset;
const itemSlot = UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_1_ENTRYID.offset;
const mountDisplayId = UPDATE_FIELDS.UNIT_FIELD_MOUNTDISPLAYID.offset;

const metadata = { id: 7, model: "Character\\Human\\Male\\HumanMale.m2", scale: 1, collisionHeight: 2, mountHeight: 0, textures: "" };

test("replay-bound frame lookups use captured clients instead of game", async () => {
  const appearance = { race: 1, sex: 0, textures: [], geosets: [], hair: "" };
  const appearanceCalls = [];
  const capturedModels = {
    get(id) { return id === 7 ? metadata : id === 9 ? { ...metadata, id: 9 } : undefined; },
    playerAppearance(...args) { appearanceCalls.push(args); return appearance; },
  };
  const loaded = [];
  const item = { entry: 100, displayId: 55, inventoryType: 13 };
  const capturedItems = {
    load(entries) { loaded.push([...entries]); return Promise.resolve(true); },
    get(entry) { return entry === item.entry ? item : undefined; },
  };
  const wrongModels = { get() { throw new Error("read mutable game creatureModels"); } };
  const wrongItems = { load() { throw new Error("read mutable game itemMetadata"); }, get() { throw new Error("read mutable game itemMetadata"); } };
  const previousModels = game.creatureModels;
  const previousItems = game.itemMetadata;
  game.creatureModels = wrongModels;
  game.itemMetadata = wrongItems;
  try {
    const player = unit([[displayId, 7], [nativeDisplayId, 7], [itemSlot, item.entry]]);
    const result = unitModelFor(player, capturedModels, capturedItems);
    assert.equal(result.appearance, appearance);
    assert.equal(appearanceCalls.length, 1);
    assert.deepEqual(loaded, [[item.entry]]);
    assert.deepEqual(visibleEquipmentFor(player, capturedItems), [{ slot: 0, inventoryType: 13, displayId: 55 }]);

    const mount = unit([[mountDisplayId, 9]]);
    assert.equal(mountModelFor(mount, capturedModels).id, 9);
  } finally {
    game.creatureModels = previousModels;
    game.itemMetadata = previousItems;
  }
});

test("existing frame wrappers still use the live clients", () => {
  const models = { get(id) { return id === 7 ? metadata : undefined; }, playerAppearance() { return undefined; } };
  const items = { load() { return Promise.resolve(false); }, get() { return undefined; } };
  const previousModels = game.creatureModels;
  const previousItems = game.itemMetadata;
  game.creatureModels = models;
  game.itemMetadata = items;
  try {
    const object = { ...unit([[displayId, 7]]), typeId: 3 };
    assert.equal(unitModel(object), metadata);
    assert.equal(mountModel(unit([[mountDisplayId, 7]])).id, 7);
    assert.deepEqual(visibleEquipment(unit([[itemSlot, 100]])), []);
  } finally {
    game.creatureModels = previousModels;
    game.itemMetadata = previousItems;
  }
});

test("world player equipment survives metadata arrival and rebuilds all playable feet", async (t) => {
  // This is deliberately the game path, not Character Lab: a wire-shaped WorldObjectState goes
  // through Frames.visibleEquipmentFor and CreatureModelClient.playerAppearance, then the result
  // is handed to the same slots/geosets/buildModel inputs WorldRenderer3D.#attachSkinnedModel uses.
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory, dbcDirectory } = await import("../tools/paths.mjs");
  const { parseM2 } = await import("../tools/m2.mjs");
  const { encodeWvm9 } = await import("../tools/wvm.mjs");
  const { decodeWvm9 } = await import("../dist/code/browser/Wvm.js");
  const { CreatureModelClient } = await import("../dist/code/browser/CreatureModelClient.js");
  const { buildModel, characterSlots, worldCharacterGeosets } =
    await import("../dist/code/browser/ModelBuild.js");
  const { CHARACTER_APPEARANCE_VERSION } = await import("../dist/code/browser/CharacterAtlas.js");
  const { CharacterAppearanceIndex } = await import("../dist/code/gateway/CharacterAppearance.js");

  const archives = await clientArchives(clientDirectory());
  const visualCandidate = resolve(process.env.VISUAL_DBC_DIR ?? join(process.cwd(), "data", "visual-dbc"));
  const patchWVisuals = existsSync(join(visualCandidate, "CreatureModelData.dbc"))
    && (await archives.locate("Character\\Human\\Male\\HumanMale.m2"))?.toLowerCase() === "patch-w.mpq"
    && (await archives.locate("DBFilesClient\\CreatureModelData.dbc"))?.toLowerCase() === "patch-w.mpq";
  if (!patchWVisuals) {
    archives.close();
    t.skip("requires the coordinated patch-W model and visual DBC pack");
    return;
  }
  const modelFor = async (race, sex, directory, name) => {
    const gender = sex === 0 ? "Male" : "Female";
    const base = `Character\\${directory}\\${gender}\\${name}`;
    const parsed = parseM2(await archives.read(`${base}.m2`), await archives.read(`${base}00.skin`));
    assert.ok(parsed, `${name} active model is available`);
    const encoded = encodeWvm9(parsed, undefined);
    return { base, wvm: decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)) };
  };
  const profiles = [
    [1, 0, "Human", "HumanMale"], [1, 1, "Human", "HumanFemale"],
    [2, 0, "Orc", "OrcMale"], [2, 1, "Orc", "OrcFemale"],
    [3, 0, "Dwarf", "DwarfMale"], [3, 1, "Dwarf", "DwarfFemale"],
    [4, 0, "NightElf", "NightElfMale"], [4, 1, "NightElf", "NightElfFemale"],
    [5, 0, "Scourge", "ScourgeMale"], [5, 1, "Scourge", "ScourgeFemale"],
    [6, 0, "Tauren", "TaurenMale"], [6, 1, "Tauren", "TaurenFemale"],
    [7, 0, "Gnome", "GnomeMale"], [7, 1, "Gnome", "GnomeFemale"],
    [8, 0, "Troll", "TrollMale"], [8, 1, "Troll", "TrollFemale"],
    [10, 0, "BloodElf", "BloodElfMale"], [10, 1, "BloodElf", "BloodElfFemale"],
    [11, 0, "Draenei", "DraeneiMale"], [11, 1, "Draenei", "DraeneiFemale"],
  ];
  const models = new Map();
  for (const [race, sex, directory, name] of profiles) {
    models.set(`${race}:${sex}`, { race, sex, directory, name,
      ...(await modelFor(race, sex, directory, name)) });
  }
  const visualDbc = existsSync(join(visualCandidate, "CreatureModelData.dbc"))
    ? visualCandidate : dbcDirectory();
  const appearanceIndex = await CharacterAppearanceIndex.load(
    dbcDirectory(), undefined, visualDbc, true);
  const itemRows = new Map([
    [832, { entry: 832, displayId: 6847, inventoryType: 6 }],
    [40, { entry: 40, displayId: 10141, inventoryType: 8 }],
  ]);
  const originalFetch = globalThis.fetch;
  try {
    for (const profile of models.values()) {
      const { race, sex, name } = profile;
      let metadataReady = false;
      const itemMetadata = {
        async load() { return true; },
        get(entry) { return metadataReady ? itemRows.get(entry) : undefined; },
      };
      const appearanceClient = new CreatureModelClient("http://gateway.test");
      const creatureModels = {
        get(display) {
          return display === 7 ? {
            id: display, model: `${profile.base}.m2`, scale: 1, collisionHeight: 2,
            mountHeight: 0, textures: "",
          } : undefined;
        },
        playerAppearance: appearanceClient.playerAppearance.bind(appearanceClient),
      };
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        assert.equal(url.pathname, "/dbc/character-appearance");
        assert.equal(url.searchParams.get("v"), String(CHARACTER_APPEARANCE_VERSION));
        assert.equal(CHARACTER_APPEARANCE_VERSION, 13);
        const items = (url.searchParams.get("items") ?? "").split(",").filter(Boolean).map((entry) => {
          const [slot, inventoryType, displayId] = entry.split(":").map(Number);
          return { slot, inventoryType, displayId };
        });
        const appearance = appearanceIndex.forPlayer(race, sex, 0, 0, 0, 0, 0, items);
        return { ok: true, async json() { return appearance; } };
      };
      const fields = new Map([
        [displayId, 7], [nativeDisplayId, 7],
        [UPDATE_FIELDS.UNIT_FIELD_BYTES_0.offset, race | (sex << 16)],
        [UPDATE_FIELDS.PLAYER_BYTES.offset, 0], [UPDATE_FIELDS.PLAYER_BYTES_2.offset, 0],
        [itemSlot + 5 * (UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - itemSlot), 832],
        [itemSlot + 7 * (UPDATE_FIELDS.PLAYER_VISIBLE_ITEM_2_ENTRYID.offset - itemSlot), 40],
      ]);
      const object = { guid: BigInt(race), typeId: 4, fields };

      // First frame: visible entries are known by the server, but item metadata is not. The world
      // gets the bare appearance while the client asks for the item rows; it must not cache this as
      // the final dressed key.
      assert.equal(unitModelFor(object, creatureModels, itemMetadata), undefined);
      await new Promise((resolve) => setImmediate(resolve));
      const bare = unitModelFor(object, creatureModels, itemMetadata);
      assert.ok(bare?.appearance, `${race}: bare appearance arrives before item metadata`);
      assert.deepEqual(visibleEquipmentFor(object, itemMetadata), []);

      // Metadata arrival makes a different playerAppearance key. One async turn later the world
      // rebuild sees the complete body and the lower-body geosets, rather than retaining the bare
      // model/atlas forever.
      metadataReady = true;
      assert.equal(unitModelFor(object, creatureModels, itemMetadata), undefined);
      await new Promise((resolve) => setImmediate(resolve));
      const dressed = unitModelFor(object, creatureModels, itemMetadata);
      assert.ok(dressed?.appearance, `${race}: dressed appearance arrives after metadata`);
      assert.deepEqual(visibleEquipmentFor(object, itemMetadata), [
        { slot: 5, inventoryType: 6, displayId: 6847 },
        { slot: 7, inventoryType: 8, displayId: 10141 },
      ]);
      const appearance = dressed.appearance;
      assert.ok(appearance.body.some((layer) => layer.section === "legLower"),
        `${race}: boots contribute the lower-leg atlas layer`);
      assert.ok(appearance.body.some((layer) => layer.section === "foot"),
        `${race}: boots contribute the foot atlas layer`);

      // This is the world material seam: body type 1 is the atlas supplied by the renderer, and
      // buildModel is called with the same characterSlots/worldCharacterGeosets pair as
      // #attachSkinnedModel.
      const bodyAtlas = new THREE.Texture();
      const geosets = worldCharacterGeosets(profile.wvm, appearance, true);
      const built = buildModel(profile.wvm, {
        modelPath: `${profile.base}.m2`, slots: characterSlots("", appearance),
        geosets, baseUrl: "http://gateway.test",
        loadTexture: () => new THREE.Texture(), slotTextures: new Map([[1, bodyAtlas]]), skinned: false,
      });
      assert.ok(built.geometry.groups.some((group) => group.count > 0),
        `${race}: world rebuild has visible material groups`);
      const groupDraws = (geosetId) => profile.wvm.submeshes.some((submesh) =>
        submesh.geosetId === geosetId && built.geometry.groups.some((group) =>
          group.start === submesh.indexStart && group.count === submesh.indexCount));
      const bootStats = new Map();
      for (const submesh of profile.wvm.submeshes) {
        if (submesh.geosetId < 500 || submesh.geosetId >= 600 || submesh.indexCount <= 0) continue;
        let uvMax = bootStats.get(submesh.geosetId) ?? 0;
        for (let i = submesh.indexStart; i < submesh.indexStart + submesh.indexCount; i++) {
          uvMax = Math.max(uvMax, profile.wvm.uv0[profile.wvm.indices[i] * 2 + 1]);
        }
        bootStats.set(submesh.geosetId, uvMax);
      }
      const selectedBoot = [...(geosets.explicit ?? [])].find((id) => id >= 500 && id < 600);
      const selectedStats = selectedBoot === undefined ? undefined : { id: selectedBoot, uvMax: bootStats.get(selectedBoot) };
      const footCandidates = [...bootStats].filter(([, uvMax]) => uvMax > 0.8755);
      if (footCandidates.length === 0) {
        assert.ok(selectedStats && selectedStats.uvMax !== undefined,
          `${name}: no authored foot candidate but selected boot ${selectedBoot} is absent from active WVM`);
        assert.ok(groupDraws(selectedBoot), `${name}: world build draws authored boot shaft ${selectedBoot}`);
        console.log(`${name}: asset boundary, boot shaft ${selectedBoot} has no authored foot-atlas UV`);
      } else {
        assert.ok(selectedStats && selectedStats.uvMax > 0.8755,
          `${name}: selected boot ${selectedBoot} lacks foot UV; candidates=${footCandidates.map(([id, uvMax]) => `${id}:${uvMax.toFixed(4)}`)}`);
        assert.ok(groupDraws(selectedBoot), `${name}: world build draws selected boot ${selectedBoot}`);
      }
      const beltCandidates = profile.wvm.submeshes
        .filter((submesh) => submesh.geosetId >= 1800 && submesh.geosetId < 1900 && submesh.indexCount > 0)
        .map((submesh) => submesh.geosetId)
        .filter((id, index, ids) => ids.indexOf(id) === index);
      const selectedBelt = appearance.geosets.find((id) => id >= 1800 && id < 1900);
      if (beltCandidates.length > 0) {
        assert.ok(beltCandidates.includes(selectedBelt),
          `${name}: selected belt ${selectedBelt} is not authored; candidates=${beltCandidates}`);
        assert.equal(selectedBelt, beltCandidates.includes(1801) ? 1801 : 1802,
          `${name}: prefer authored 1801, otherwise the profile-scoped 1802 fallback`);
        assert.ok(groupDraws(selectedBelt), `${name}: world build draws authored belt ${selectedBelt}`);
      } else {
        assert.ok(!selectedBelt || !groupDraws(selectedBelt),
          `${name}: world build cannot draw absent authored belt geometry ${selectedBelt}`);
        assert.equal(name, "GnomeMale", `${name}: active patch-W family18 gap is unexpected`);
        console.log(`${name}: asset boundary, no authored family18 belt in active WVM`);
      }
      const materials = Array.isArray(built.materials) ? built.materials : [built.materials];
      assert.ok(materials.some((material) => material.map === bodyAtlas),
        `${race}: world materials sample the composed body atlas`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    archives.close();
  }
});

test("reactionBetween and selectionRingColourFor use captured self and factions", () => {
  const self = unit([[factionId, 11]]);
  const object = unit([[factionId, 22]]);
  const factions = { reaction(mine, theirs) {
    assert.equal(mine, 11);
    assert.equal(theirs, 22);
    return 1;
  } };
  assert.equal(reactionBetween(self, object, factions), 1);
  assert.equal(selectionRingColourFor(object, self, factions), 0x4fd06a);
  assert.equal(selectionRingColourFor(undefined, self, factions), 0xffe36e);

  const previousWorld = game.world;
  const previousFactions = game.factions;
  game.world = undefined;
  game.factions = { reaction() { throw new Error("read mutable game factions"); } };
  try {
    assert.equal(selectionRingColourFor(object, self, factions), 0x4fd06a);
    assert.equal(selectionRingColour(object), 0xe0c341);
  } finally {
    game.world = previousWorld;
    game.factions = previousFactions;
  }
});

import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed (6.18 / 3.21, 11.11): the stock character and pet windows' PlayerModels over the
// production vertical and the canned seam. The PlayerModel methods are installed with a fixture host
// (the world copy is FrameXmlUnitModelLive.ts, tested without a client), then driven only through
// stock Lua: PaperDollFrame's PLAYER_ENTERING_WORLD and UNIT_MODEL_CHANGED, opening and closing the
// window, its rotate buttons (Model_RotateLeft/Right, Model_OnUpdate), and PetPaperDollFrame_Update.
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
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FrameXmlDressUpModels, installFrameXmlDressUp } = await import("../dist/code/browser/framexml/FrameXmlDressUp.js");
const {
  FrameXmlUnitModels, FrameXmlModelTurns, installFrameXmlUnitModels,
  FRAMEXML_MODEL_ANIM_STAND, FRAMEXML_MODEL_ANIM_SHUFFLE_LEFT, FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT,
} = await import("../dist/code/browser/framexml/FrameXmlUnitModel.js");
const decoder = new TextDecoder("utf-8");

const PLAYER = "0x0000000000000001";
const PET = "0xF140000000000104";

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "unit-model-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("stock CharacterModelFrame and PetModelFrame: SetUnit, show/hide, UNIT_MODEL_CHANGED and the rotate buttons", withClient, async () => {
  const seam = new CannedWorldSeam();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  try {
    await boot.load();
    const errors = boot.errorCount;
    // The fixture world: each GUID's look, copied on demand.
    const looks = new Map([[PLAYER, "plate"], [PET, "wolf"]]);
    const host = {
      copies: [],
      snapshot(guid) { const look = looks.get(guid); if (look) this.copies.push(`${guid}:${look}`); return look && { guid, look }; },
      source: (copy) => ({ key: `${copy.guid}:${copy.look}`, file: "x.m2", fitBody: true }),
    };
    const units = new FrameXmlUnitModels(host);
    let now = 0;
    const clips = new Set([FRAMEXML_MODEL_ANIM_STAND, FRAMEXML_MODEL_ANIM_SHUFFLE_LEFT, FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT]);
    const turns = new FrameXmlModelTurns({
      hasAnimation: (frame, id) => units.shows(frame) && clips.has(id),
      playing: (frame) => frame.model.sequence ?? 0,
      play: (frame, id) => { boot.bridge.update(frame, (m) => { m.model.sequence = id; }); },
      now: () => now,
    });
    let wakes = 0;
    assert.equal(installFrameXmlUnitModels(boot, units, turns, () => { wakes += 1; }), true, "found through CharacterModelFrame");

    const character = boot.bridge.getFrame("CharacterModelFrame");
    const pet = boot.bridge.getFrame("PetModelFrame");
    assert.equal(character.type, "PlayerModel");
    assert.equal(character.model.facing, 0.61, "Model_OnLoad's 0.61");

    // PaperDollFrame_OnEvent: PLAYER_ENTERING_WORLD → CharacterModelFrame:SetUnit("player"), window closed.
    boot.pump.fire("PLAYER_ENTERING_WORLD");
    assert.equal(units.guid(character), PLAYER, "SetUnit kept UnitGUID('player')");
    assert.equal(units.shows(character), false, "closed window: nothing copied");
    assert.deepEqual(host.copies, []);

    lua(boot, "ShowUIPanel(CharacterFrame)", 0);
    assert.equal(boot.bridge.isVisible(character), true);
    assert.equal(units.resolve(character)?.key, `${PLAYER}:plate`, "opening the window copies the player (0x00597870)");
    assert.ok(wakes > 0, "the stage was woken by the show");

    // An equip change: the realm's visible item → UNIT_MODEL_CHANGED("player") → SetUnit again.
    looks.set(PLAYER, "cloth");
    assert.equal(units.resolve(character)?.key, `${PLAYER}:plate`, "a copy until the event");
    boot.pump.fire("UNIT_MODEL_CHANGED", "player");
    assert.equal(units.resolve(character)?.key, `${PLAYER}:cloth`);
    boot.pump.fire("UNIT_MODEL_CHANGED", "target");
    assert.equal(host.copies.length, 2, "another unit's change is not the paper doll's");
    // DISPLAY_SIZE_CHANGED is CharacterModelFrame's own OnEvent → RefreshUnit.
    looks.set(PLAYER, "robe");
    boot.pump.fire("DISPLAY_SIZE_CHANGED");
    assert.equal(units.resolve(character)?.key, `${PLAYER}:robe`, "RefreshUnit re-copies the kept GUID");

    // The rotate buttons: a click is Model_RotateLeft → SetRotation(0.58) → ShuffleLeft.
    lua(boot, "CharacterModelFrameRotateLeftButton:Click()", 0);
    assert.ok(Math.abs(character.model.facing - 0.58) < 1e-9, `turned by 0.03 (${character.model.facing})`);
    assert.equal(character.model.sequence, FRAMEXML_MODEL_ANIM_SHUFFLE_LEFT);
    turns.update(character);
    now += 150;
    turns.update(character);
    assert.equal(character.model.sequence, FRAMEXML_MODEL_ANIM_STAND, "Stand once the step is over");
    lua(boot, "CharacterModelFrameRotateRightButton:Click()", 0);
    assert.equal(character.model.sequence, FRAMEXML_MODEL_ANIM_SHUFFLE_RIGHT);
    assert.deepEqual(lua(boot, "return pcall(CharacterModelFrame.SetRotation, CharacterModelFrame, 'left')", 2),
      [false, "Usage: SetRotation(rotation (in radians))"]);
    assert.deepEqual(lua(boot, "return pcall(CharacterModelFrame.SetUnit, CharacterModelFrame)", 2),
      [false, 'Usage: SetUnit("unit")']);
    lua(boot, "CharacterModelFrame:SetUnit('nobody')", 0);
    assert.equal(units.guid(character), PLAYER, "a token naming nobody changes nothing");

    lua(boot, "HideUIPanel(CharacterFrame)", 0);
    assert.equal(units.shows(character), false, "closing drops the copy (0x00597210)");
    const copies = host.copies.length;
    boot.pump.fire("UNIT_MODEL_CHANGED", "player");
    assert.equal(host.copies.length, copies, "with the window closed the event copies nothing");
    assert.equal(units.guid(character), PLAYER);

    // The pet window: PetModelFrame:SetUnit("pet") (PetPaperDollFrame_Update), SetCreature forgets it.
    lua(boot, "PetModelFrame:SetUnit('pet')", 0);
    assert.equal(units.guid(pet), PET);
    assert.equal(units.shows(pet), false);
    lua(boot, "ShowUIPanel(CharacterFrame); PetPaperDollFrame:Show()", 0);
    assert.equal(boot.bridge.isVisible(pet), true, "the pet tab's model is shown");
    assert.equal(units.resolve(pet)?.key, `${PET}:wolf`, "the pet's creature model, through the same path");
    lua(boot, "PetModelFrame:SetCreature(1)", 0);
    assert.equal(units.has(pet), false, "SetCreature ends the unit view (0x00597960)");
    assert.equal(pet.model.creatureEntry, 1);
    lua(boot, "PetModelFrame:SetUnit('pet')", 0);
    assert.equal(pet.model.creatureEntry, undefined, "SetUnit lets go of the creature (the id stage stops)");
    lua(boot, "HideUIPanel(CharacterFrame)", 0);

    // DressUpModel inherits RefreshUnit, which is Dress (0x00597ed0 = 0x00597b00's body).
    const dress = new FrameXmlDressUpModels({
      look: () => ({ displayId: 49, race: 1, sex: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0, facialHair: 0,
        equipment: [{ slot: 4, inventoryType: 5, displayId: 9001 }] }),
      item: () => undefined,
    });
    assert.equal(installFrameXmlDressUp(boot, dress, () => {}, turns), true);
    const dressUp = boot.bridge.getFrame("DressUpModel");
    lua(boot, "DressUpModel:SetUnit('player'); DressUpModel:Undress()", 0);
    assert.equal(dress.outfit(dressUp)?.equipment.length, 0);
    lua(boot, "DressUpModel:RefreshUnit()", 0);
    assert.equal(dress.outfit(dressUp)?.equipment.length, 1, "RefreshUnit dresses the unit again");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-3))}`);
  } finally {
    boot.close();
  }
});

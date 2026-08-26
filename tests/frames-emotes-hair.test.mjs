import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { pendingActionFate } from "../dist/code/browser/AnimatedModel.js";
import {
  ANIMATION_DATA_AVAILABLE, EMOTE_ANIMATIONS, ANIMATION_FALLBACK, BASE_ANIMATIONS,
} from "../dist/code/generated/animations.js";
import { CLASS_ICON_DATA_AVAILABLE } from "../dist/code/generated/classIcons.js";
import { CLASS_ATLAS_CELL_SIZE, classIconOffset } from "../dist/code/browser/ui/UnitSnapshot.js";
import { buildCreateCharacter } from "../dist/code/world/CharacterProtocol.js";
import { CharacterAppearanceIndex } from "../dist/code/gateway/CharacterAppearance.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };
const withAnimationData = {
  skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data",
};
const withClassIconData = {
  skip: CLASS_ICON_DATA_AVAILABLE ? false : "no locally generated class-icon data",
};

test("Ж5.3 an emote whose clip is still in flight waits instead of being thrown away", () => {
  // The clip is here: play it, as it always did.
  assert.equal(pendingActionFate({ hasClip: true, promised: true, now: 0, waitUntil: 100 }), "play");
  // The model does not claim the pose at all. Nothing is coming and holding the record would leave
  // the unit waiting on a request that will never be made.
  assert.equal(pendingActionFate({ hasClip: false, promised: false, now: 0, waitUntil: 100 }), "drop");
  // The model claims it and the keyframes are on their way. This is the whole of Ж5.3: the request
  // goes out on this frame and does not come back on this frame, so deleting the record here threw
  // the emote away before its own clip could possibly have arrived — and then did it again on the
  // next emote, because the fetch was still in flight for that one too.
  assert.equal(pendingActionFate({ hasClip: false, promised: true, now: 0, waitUntil: 100 }), "wait");
  // And the wait is bounded: a gesture a second late is worse than one that did not happen.
  assert.equal(pendingActionFate({ hasClip: false, promised: true, now: 100, waitUntil: 100 }), "drop");
});

test("Ж5.3 almost every emote in the table needs the fetch that used to lose it", withAnimationData, () => {
  // The measurement the fix rests on. If most emotes shipped with their models, dropping the
  // record would have cost a handful of gestures; they do not, so it cost nearly all of them.
  const base = new Set(BASE_ANIMATIONS);
  const resolves = (id) => {
    let animation = id;
    for (let hop = 0; hop < 8 && animation !== undefined && animation >= 0; hop++) {
      if (base.has(animation)) return true;
      animation = ANIMATION_FALLBACK[animation];
    }
    return false;
  };
  const rows = Object.values(EMOTE_ANIMATIONS);
  const shipped = rows.filter((row) => resolves(row.animation)).length;
  assert.ok(rows.length > 150, `the table should hold every emote, not ${rows.length}`);
  // Measured on this dataset: nine of a hundred and sixty-five.
  assert.ok(shipped * 10 < rows.length,
    `${shipped} of ${rows.length} emotes resolve to an animation that travels with the model; `
    + "if that were most of them the dropped record would not have mattered");
});

test("Ж5.1 the class portrait picks a cell of the client's own atlas", withClassIconData, () => {
  // The frame carried a literal `/icons/2273.png` — the generic humanoid glyph — and nothing ever
  // wrote to it, so 66 of its 279 usable pixels said the same thing to every character in the game.
  // `UI-Classes-Circles.blp` is 256x256 with ten 64px cells in it, laid out the way the original
  // FrameXML's `CLASS_ICON_TCOORDS` declares.
  const size = 58;
  const inset = (size - CLASS_ATLAS_CELL_SIZE) / 2;
  assert.equal(classIconOffset(1, size), `${inset}px ${inset}px`, "warrior is the first cell");
  assert.equal(classIconOffset(8, size), `${-CLASS_ATLAS_CELL_SIZE + inset}px ${inset}px`, "mage is beside it");
  assert.equal(classIconOffset(3, size), `${inset}px ${-CLASS_ATLAS_CELL_SIZE + inset}px`, "hunter starts the second row");
  assert.equal(classIconOffset(6, size),
    `${-CLASS_ATLAS_CELL_SIZE + inset}px ${-2 * CLASS_ATLAS_CELL_SIZE + inset}px`,
    "the death knight is the last one the atlas has");

  // Ten classes, ten cells, and nothing for a number that is not one of them.
  const cells = new Set();
  for (const classId of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]) {
    const offset = classIconOffset(classId, size);
    assert.ok(offset, `class ${classId} has no cell`);
    assert.ok(!cells.has(offset), `class ${classId} shares a cell with another`);
    cells.add(offset);
  }
  assert.equal(classIconOffset(10, size), undefined, "there is no class 10");
  assert.equal(classIconOffset(undefined, size), undefined);
});

test("Ж5.2 the top-left corner is a column and not a stack of guessed offsets", async () => {
  // Six blocks lived at hard `top` values that each assumed how tall the others were. The player
  // aura budget is 24 icons, which at 34px and a 4px gap inside 300px is three rows and 110px —
  // so a fully buffed character's strip ran from 91 to 201, straight through the swing warning at
  // 138 and the combat log at 168.
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/browser/style.css", import.meta.url), "utf8");

  const rail = /<div id="left-rail"[\s\S]*?\n          <\/div>/.exec(html);
  assert.ok(rail, "the left column has to exist");
  for (const id of ["player-hud", "player-auras", "secondary-frames", "party-frames", "swing-warning", "combat-log"]) {
    assert.ok(rail[0].includes(`id="${id}"`), `${id} belongs in the column`);
  }
  // And the target's auras belong under its button row, which hangs below the frame.
  const target = /<div id="target-rail"[\s\S]*?\n          <\/div>/.exec(html);
  assert.ok(target && target[0].includes('id="target-panel"') && target[0].includes('id="target-auras"'));
  assert.ok(target[0].indexOf('id="target-panel"') < target[0].indexOf('id="target-auras"'));

  // Nothing in the corner may pin itself again: a hard `top` inside a flow column is how this
  // started, and one reintroduced rule would put the overlap back without failing anything else.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const selector of [".aura-strip", ".combat-log", ".swing-warning", ".party-frames", ".secondary-frames"]) {
    const rule = new RegExp(`(^|})\\s*${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(bare);
    assert.ok(rule, `${selector} should still have a rule`);
    assert.ok(!/(^|;)\s*(top|left):/.test(rule[2]),
      `${selector} pins itself again: ${rule[2].trim()}`);
  }
});

test("В a character is created with the appearance the form chose, not with five zeros", () => {
  // `buildCreateCharacter` always defaulted the five bytes to zero and the form never supplied
  // them, so every character made here was born skin 0, face 0, hair 0 — and for a human male
  // hair 0 is `CharHairGeosets` row 21: geoset 0, three empty texture slots, bald by data. The
  // renderer was drawing exactly what was asked for.
  const packet = buildCreateCharacter({
    name: "Тралл", race: 2, classId: 7, gender: 0,
    skin: 4, face: 11, hairStyle: 3, hairColor: 2, facialHair: 6,
  });
  const nameBytes = new TextEncoder().encode("Тралл").length;
  const tail = packet.slice(nameBytes + 1);
  assert.deepEqual([...tail], [2, 7, 0, 4, 11, 3, 2, 6, 0], "race, class, sex, then the five bytes");

  // The old shape is still legal, and still what an omitted field means.
  const bald = buildCreateCharacter({ name: "A", race: 1, classId: 1, gender: 0 });
  assert.deepEqual([...bald.slice(2)], [1, 1, 0, 0, 0, 0, 0, 0, 0]);
});

test("В the form is offered the choices the client's own tables have", withDataset, async () => {
  const index = await CharacterAppearanceIndex.load(dbcDirectory);
  const human = index.options(1, 0);
  // Listed, not counted, and per race *and* per sex: nothing about these is uniform.
  //
  // Twelve hairstyles and not the seventeen the table has rows for: since the review the list is
  // also what `Player::ValidateAppearance(create=true)` will take, and the human male's styles 12
  // to 16 carry no `SECTION_FLAG_PLAYER` at any colour, so creation refused them for every class.
  assert.equal(human.hairStyles.length, 12);
  assert.equal(human.hairColors.length, 13);
  assert.equal(human.faces.length, 24);
  assert.equal(human.skins.length, 13);
  assert.equal(human.facialHairs.length, 9);
  // A human woman has more faces and more hairstyles, and — from `CharacterFacialHairStyles`, the
  // table that decides what is drawn — seven facial-hair variations rather than none. Counting
  // `CharSections` gave her 0 and hid the control: she has no facial-hair *texture* row at all,
  // and the core does not ask for one (`Player.cpp:27296-27303`).
  const woman = index.options(1, 1);
  assert.equal(woman.faces.length, 30);
  assert.equal(woman.hairStyles.length, 19);
  assert.equal(woman.facialHairs.length, 7);
});

test("В a hairstyle the table has never had falls back to the race's own bald head", withDataset, async () => {
  const index = await CharacterAppearanceIndex.load(dbcDirectory);
  // The byte comes off the wire and the core never checks it against `CharHairGeosets`, so a
  // character made by any tool that guessed can carry a variation this race has never had.
  const bald = index.forPlayer(1, 0, 4, 11, 0, 0, 6);
  const impossible = index.forPlayer(1, 0, 4, 11, 99, 0, 6);
  assert.deepEqual(impossible.geosets, bald.geosets);
  // The same picture the bald head gets, and neither of them draws a hair geoset with it: the type
  // 6 slot is the hair *colour's* texture, and the beard this character is wearing samples it.
  assert.equal(impossible.hair, bald.hair);
  assert.match(bald.hair, /^Character\\Human\\Hair\d\d_00\.blp$/);
  // And a style that does exist still adds its own geoset and its own texture.
  //
  // Which geoset, not how many. Since Т4 the bald head carries one of its own — geoset 1, the cap
  // over the crown that `Showscalp` asks for and that nothing used to draw — so the two lists are
  // the same length now, and comparing lengths measured nothing about either of them.
  const real = index.forPlayer(1, 0, 4, 11, 3, 0, 6);
  assert.ok(real.hair.length > 0, "a real hairstyle has a texture");
  assert.ok(real.geosets.some((geoset) => !bald.geosets.includes(geoset)),
    `a geoset the bald head does not have: ${real.geosets} against ${bald.geosets}`);
  assert.ok(bald.geosets.includes(1), "and the bald head is capped rather than open at the crown");
});

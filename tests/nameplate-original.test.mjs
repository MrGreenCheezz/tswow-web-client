// 03.11 (6.37): the plate as Wow.exe draws it. The numbers are what its own frames said through Lua, on a 768-unit screen
// (F:\WowOracle\runs\plates-probe*.txt): a plate 156.651 by 39.163, a bar 125.948 by 11.005 at 4.86, 4.90 from the bottom left.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PLATE_BORDER_TEXTURE, PLATE_ELITE_TEXTURE, PLATE_GLOW_TEXTURE, PLATE_HEIGHT, PLATE_NAME_RAISE, PLATE_RAID_TEXTURE, PLATE_RANGE,
  PLATE_SHIELD_TEXTURE, PLATE_SKULL_TEXTURE, PLATE_WIDTH, RANK_BOSS, RANK_ELITE, RANK_NORMAL, RANK_RARE, RANK_RARE_ELITE, alphaFromBrightness, drawPlate,
  plateColour, plateLayout, plateLevelColour, plateShowsElite, plateShowsSkull, plateVisible,
} from "../dist/code/browser/NamePlate.js";
import { REACTION_FRIENDLY, REACTION_HOSTILE, REACTION_NEUTRAL } from "../dist/code/world/FactionRules.js";

function recordingContext() {
  const calls = [];
  const state = { fillStyle: "", font: "", textAlign: "", textBaseline: "", globalAlpha: 1, globalCompositeOperation: "source-over" };
  const context = new Proxy(state, {
    get: (target, property) => (property in target ? target[property] : (...args) => {
      calls.push({ name: property, args, fillStyle: target.fillStyle, font: target.font, alpha: target.globalAlpha, blend: target.globalCompositeOperation });
    }),
    set: (target, property, value) => { target[property] = value; return true; },
  });
  return { context, calls };
}

const picture = (path) => ({ path, width: 128, height: 64 });
const art = {
  image: (path) => picture(path),
  tinted: (path, colour) => ({ ...picture(path), colour }),
  added: (path) => ({ ...picture(path), added: true }),
};
const plate = (overrides = {}) => ({
  guid: 7n, name: "Hostile Normal", level: 80, playerLevel: 80, reaction: REACTION_HOSTILE, classColour: undefined,
  health: 0.5, raidMark: undefined, rank: RANK_NORMAL, cast: undefined, target: false, ...overrides,
});
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-3, `${message}: ${actual} vs ${expected}`);
const draw = (data, box = plateLayout(600, 200, 768)) => {
  const { context, calls } = recordingContext();
  drawPlate(context, box, data, art);
  return { calls, box, images: calls.filter((call) => call.name === "drawImage") };
};
const imageOf = (images, path) => images.find((call) => call.args[0].path === path);

test("a plate is a fixed part of the screen's height, hung by its top from the anchor", () => {
  const box768 = plateLayout(600, 200, 768);
  near(box768.width, PLATE_WIDTH, "width");
  near(box768.height, PLATE_HEIGHT, "height");
  near(box768.x + box768.width / 2, 600, "centre");
  near(box768.y, 200, "top");
  const box720 = plateLayout(600, 200, 720);
  near(box720.width, 146.86, "the stand's 720: its 147 pixels");
  near(box720.height, 36.715, "and 37");
  assert.equal(PLATE_NAME_RAISE, 2 / 3);
});

test("the health bar lies under the border, cut at its value and not squeezed", () => {
  const { images, box } = draw(plate({ health: 0.7 }));
  const bar = images[0];
  assert.equal(bar.args[0].colour, "#ff0000");
  assert.equal(bar.args[3], 128 * 0.7, "the texture is cut");
  near(bar.args[5], box.x + 4.86, "left");
  near(bar.args[6], box.y + 39.163 - 4.9 - 11.005, "top");
  near(bar.args[7], 125.948 * 0.7, "width");
  near(bar.args[8], 11.005, "height");
  const border = imageOf(images, PLATE_BORDER_TEXTURE);
  assert.ok(images.indexOf(border) > images.indexOf(bar), "the border goes over it");
  assert.deepEqual(border.args.slice(1), [box.x, box.y, box.width, box.height]);
});

test("no health from the server is no bar, not an empty or a full one", () => {
  const { images } = draw(plate({ health: undefined }));
  assert.equal(images.filter((call) => call.args[0].colour).length, 0);
});

test("the name is white, centred over the plate's middle, with its shadow; the level sits in its box", () => {
  const { calls, box } = draw(plate());
  const texts = calls.filter((call) => call.name === "fillText");
  const shadow = texts.find((call) => call.args[0] === "Hostile Normal" && call.fillStyle === "#000000");
  const name = texts.find((call) => call.args[0] === "Hostile Normal" && call.fillStyle === "#ffffff");
  assert.ok(shadow && name);
  near(name.args[1], box.x + box.width / 2, "name x");
  near(name.args[2], box.y + box.height / 2, "name's bottom on the middle");
  near(shadow.args[1] - name.args[1], 1.567, "shadow right");
  near(shadow.args[2] - name.args[2], 1.567, "shadow down");
  assert.match(name.font, /15\.665px "WoW Friz"/);
  const level = texts.find((call) => call.args[0] === "80" && call.fillStyle !== "#000000");
  near(level.args[1], box.x + box.width - 14.41, "level x");
  near(level.args[2], box.y + box.height - 11.12, "level y");
  assert.match(level.font, /14\.099px/);
});

test("the bar's colour goes by reaction, and somebody else's kill does not change it", () => {
  assert.equal(plateColour({ reaction: REACTION_HOSTILE }), "#ff0000");
  assert.equal(plateColour({ reaction: REACTION_NEUTRAL }), "#ffff00");
  assert.equal(plateColour({ reaction: REACTION_FRIENDLY }), "#00ff00");
  assert.equal(plateColour({ reaction: REACTION_FRIENDLY, isPlayer: true }), "#0000ff", "a friendly player is blue");
  assert.equal(plateColour({ reaction: REACTION_NEUTRAL, isPlayer: true }), "#0000ff");
  assert.equal(plateColour({ reaction: REACTION_HOSTILE, isPlayer: true }), "#ff0000", "a hostile one red");
  assert.equal(plateColour({ reaction: REACTION_HOSTILE, isPlayer: true, classColour: "#c41f3b" }), "#c41f3b", "or its class with the CVar on");
  assert.equal(plateColour({ reaction: REACTION_HOSTILE, colourReaction: REACTION_FRIENDLY }), "#00ff00", "the unit's view of the player");
});

test("a level's colour is measured from the player's", () => {
  const at80 = [[85, "#ff1919"], [84, "#ff7f3f"], [83, "#ff7f3f"], [82, "#ffff00"], [79, "#ffff00"], [78, "#ffff00"], [77, "#3fb23f"], [72, "#3fb23f"], [71, "#7f7f7f"], [70, "#7f7f7f"], [60, "#7f7f7f"]];
  for (const [level, colour] of at80) assert.equal(plateLevelColour(level, 80), colour, `level ${level}`);
  // The green reaches less far down at a low level: 5 levels at 10 to 19, 4 below that.
  assert.equal(plateLevelColour(5, 10), "#3fb23f");
  assert.equal(plateLevelColour(4, 10), "#7f7f7f");
  assert.equal(plateLevelColour(2, 7), "#7f7f7f", "2 is 5 below, one past the 4 at level 7");
  assert.equal(plateLevelColour(3, 7), "#3fb23f");
  assert.equal(plateLevelColour(50, undefined), "#ffff00");
});

test("the skull takes the level's place for a boss and for what is hostile and ten above", () => {
  const data = { reaction: REACTION_HOSTILE, playerLevel: 80 };
  assert.equal(plateShowsSkull({ ...data, level: 83, boss: true }), true);
  assert.equal(plateShowsSkull({ ...data, level: 95 }), true, "measured at 95 against 80");
  assert.equal(plateShowsSkull({ ...data, level: 90 }), true);
  assert.equal(plateShowsSkull({ ...data, level: 89 }), false);
  assert.equal(plateShowsSkull({ reaction: REACTION_FRIENDLY, playerLevel: 80, level: 95 }), false);
  const { images, calls, box } = draw(plate({ boss: true, level: 83 }));
  const skull = imageOf(images, PLATE_SKULL_TEXTURE);
  near(skull.args[1] + 15.665 / 2, box.x + box.width - 14.41, "where the level was");
  assert.equal(calls.some((call) => call.name === "fillText" && call.args[0] === "83"), false);
});

test("the dragon goes by elite ranks and the boss flag, under the border; a rank of 3 alone or a rare has none", () => {
  assert.equal(plateShowsElite({ rank: RANK_ELITE }), true);
  assert.equal(plateShowsElite({ rank: RANK_RARE_ELITE }), true);
  assert.equal(plateShowsElite({ rank: RANK_BOSS, boss: true }), true);
  assert.equal(plateShowsElite({ rank: RANK_BOSS }), false, "measured: rank 3 with no boss flag has neither dragon nor skull");
  assert.equal(plateShowsElite({ rank: RANK_RARE }), false);
  assert.equal(plateShowsElite({ rank: RANK_NORMAL }), false);
  const { images, box } = draw(plate({ rank: RANK_ELITE }));
  const elite = imageOf(images, PLATE_ELITE_TEXTURE);
  assert.ok(images.indexOf(elite) < images.indexOf(imageOf(images, PLATE_BORDER_TEXTURE)));
  assert.deepEqual(elite.args.slice(1, 5), [0, 0, 128 * 0.578125, 64 * 0.84375], "a piece of the picture");
  near(elite.args[7], 46.055, "width");
  near(elite.args[5] + 46.055 / 2, box.x + box.width - 14.41 + 4.7, "centred right of the level");
  near(elite.args[6] + 33.68 / 2, box.y + box.height - 11.12 + 1.57, "and under it");
});

test("the target's cast hangs half a plate lower in the same border turned round, with the spell in its level box", () => {
  const { calls, images, box } = draw(plate({ target: true, cast: { iconPath: "Interface\\Icons\\Spell_Fire_FlameBolt.blp", progress: 0.25 } }));
  const fill = images.find((call) => call.args[0].colour === "#ffb300");
  near(fill.args[5], box.x + box.width - 4.895 - 125.948, "the bar's left");
  near(fill.args[6], box.y + 19.58 + 39.163 - 4.895 - 11.005, "and top");
  near(fill.args[7], 125.948 * 0.25, "cut at the fraction");
  const scale = calls.find((call) => call.name === "scale");
  assert.deepEqual(scale.args, [-1, 1], "turned round");
  const moved = calls.find((call) => call.name === "translate");
  near(moved.args[0], box.x + box.width, "from the right edge");
  near(moved.args[1], box.y + 19.58, "half a plate lower");
  const icon = imageOf(images, "Interface\\Icons\\Spell_Fire_FlameBolt.blp");
  near(icon.args[1] + 15.665 / 2, box.x + 14.41, "icon x");
  near(icon.args[2] + 15.665 / 2, box.y + 19.58 + 39.163 - 11.12, "icon y");
  const shielded = draw(plate({ target: true, cast: { iconPath: undefined, progress: 0.25, shielded: true } }));
  assert.ok(imageOf(shielded.images, PLATE_SHIELD_TEXTURE));
  assert.equal(shielded.calls.some((call) => call.name === "scale"), false, "the shield instead of the turned border");
});

test("a raid mark is a cell of the sheet left of the plate", () => {
  const { images, box } = draw(plate({ raidMark: 5 }));
  const mark = imageOf(images, PLATE_RAID_TEXTURE);
  assert.deepEqual(mark.args.slice(1, 5), [32, 16, 32, 16], "row 1, column 1 of four by four");
  near(mark.args[5] + 31.33, box.x, "its right on the plate's left");
  near(mark.args[6] + 31.33 / 2, box.y + box.height / 2, "centred on the plate");
  assert.equal(imageOf(draw(plate({ raidMark: 8 })).images, PLATE_RAID_TEXTURE), undefined);
});

test("a target dims every other plate to 127 of 255; the mouse adds the glow", () => {
  assert.equal(draw(plate({ dimmed: true })).images[0].alpha, 127 / 255);
  assert.equal(draw(plate({ target: true })).images[0].alpha, 1);
  assert.equal(draw(plate()).images[0].alpha, 1, "nothing targeted, nothing dimmed");
  const glow = imageOf(draw(plate({ hovered: true })).images, PLATE_GLOW_TEXTURE);
  assert.equal(glow.blend, "lighter");
  assert.equal(glow.args[0].added, true, "6.38: the glow's black must not arrive as opaque black");
  assert.equal(imageOf(draw(plate()).images, PLATE_GLOW_TEXTURE), undefined);
});

test("6.38: an added picture's black is nothing and its light stays what it was", () => {
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 255,
    128, 64, 0, 255,
    255, 255, 255, 255,
    200, 100, 0, 128,
    30, 40, 50, 0,
  ]);
  alphaFromBrightness(pixels);
  assert.deepEqual([...pixels.slice(3, 4)], [0], "opaque black becomes transparent");
  assert.deepEqual([...pixels.slice(4, 8)], [255, 128, 0, 128], "half light: the colour lifted, the brightness in alpha");
  assert.deepEqual([...pixels.slice(8, 12)], [255, 255, 255, 255], "full white stays");
  assert.deepEqual([...pixels.slice(12, 16)], [255, 127, 0, 100], "its own alpha counts: 200 at half is 100 of light");
  assert.equal(pixels[19], 0, "transparent stays transparent");
});

test("threat lights the flash from the status at which the unit is on the player", () => {
  const flash = (threat) => draw(plate({ threat })).images.find((call) => call.args[0].colour && call.args[0].colour !== "#ff0000" || (call.args[0].path ?? "").includes("Flash"));
  assert.equal(flash(1), undefined);
  assert.equal(flash(undefined), undefined);
  assert.equal(flash(2).args[0].colour, "#ff9900");
  assert.equal(flash(3).args[0].colour, "#ff0000");
  const { args } = flash(3);
  near(args[7], 172.316, "width");
  near(args[8], 45.429, "height");
});

test("without its pictures a plate is still a bar and a name", () => {
  const { context, calls } = recordingContext();
  drawPlate(context, plateLayout(600, 200, 768), plate());
  assert.equal(calls.filter((call) => call.name === "drawImage").length, 0);
  assert.ok(calls.some((call) => call.name === "fillRect" && call.fillStyle === "#ff0000"));
  assert.ok(calls.some((call) => call.name === "fillText" && call.args[0] === "Hostile Normal"));
});

test("41 yards for everyone: the target has no exemption", () => {
  const filter = { hostile: true, friendly: true };
  assert.equal(PLATE_RANGE, 41);
  assert.equal(plateVisible({ reaction: REACTION_HOSTILE, target: true }, 41, filter), true);
  assert.equal(plateVisible({ reaction: REACTION_HOSTILE, target: true }, 41.5, filter), false);
  assert.equal(plateVisible({ reaction: REACTION_FRIENDLY }, 10, { hostile: true, friendly: false }), false);
  assert.equal(plateVisible({ reaction: REACTION_NEUTRAL }, 10, { hostile: true, friendly: false }), true);
});

test("the objective's badge stands straight over the creature, on the plate's own anchor", () => {
  const overlay = readFileSync(new URL("../src/browser/ui/HeadOverlay.ts", import.meta.url), "utf8");
  assert.doesNotMatch(overlay, /QUEST_MARKER_X_PX/, "the 86 pixels to the side are what made it look off the creature");
  assert.match(overlay, /translate\(\$\{Math\.round\(anchor\.x\)\}px, \$\{Math\.round\(anchor\.y - QUEST_MARKER_GAP_PX\)\}px\)/);
  assert.match(overlay, /resultUnitNamePoint\(game\.renderer\?\.results, guid\)/, "and on the model as drawn");
});

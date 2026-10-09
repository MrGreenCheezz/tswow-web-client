import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock RuneFrame.xml (stock TOC line 138) in the production vertical for a canned
// death knight — the real 3.3.5 RuneFrame.lua, UnitFrame_SetUnit's RuneFrame branch
// (UnitFrame.lua:64-77) and PlayerFrame_ToPlayerArt against FrameXmlRunes.ts's GetRuneType,
// GetRuneCooldown, RUNE_POWER_UPDATE and RUNE_TYPE_UPDATE. Without the file a death knight's
// PLAYER_ENTERING_WORLD indexes a nil RuneFrame and PlayerFrame_ToPlayerArt stops at its first line.
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

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const WITHOUT_RUNE_FRAME = FRAMEXML_VERTICAL_TOC.filter((entry) => normalize(entry) !== "runeframe.xml");

/** The canned player as a death knight (the canned race is Human, one RuneFrame_OnLoad accepts), or the canned warrior. */
async function load(subset, { deathKnight = true } = {}) {
  const seam = new CannedWorldSeam();
  if (deathKnight) seam.setPlayerClass("Рыцарь смерти", "DEATHKNIGHT");
  const requests = new Set();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.add(normalize(path));
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset, seam, exercise: true,
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => ({ width: 1365, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory, requests };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "rune-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
  widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
  luaFailed: inventory.lua.failed });
const errorKey = (error) => `${error.file}:${error.line}:${error.message}`;
const runeFrameErrors = (inventory) => inventory.errors.filter((error) => /RuneFrame/.test(error.message)).map(errorKey);

/**
 * Undo what PlayerFrame_ToPlayerArt restores (PlayerFrame.lua:340-362: PlayerFrame_ToVehicleArt sets the
 * same widgets the other way), run PLAYER_ENTERING_WORLD, and report whether the function got to its end.
 */
function toPlayerArtReachesItsEnd(boot) {
  lua(boot, "PlayerFrameBackground:SetWidth(114) PlayerLevelText:Hide() PlayerFrameHealthBar:SetWidth(100)", 0);
  boot.pump.fire("PLAYER_ENTERING_WORLD");
  const [background, level, health] = lua(boot,
    "return PlayerFrameBackground:GetWidth(), PlayerLevelText:IsShown(), PlayerFrameHealthBar:GetWidth()", 3);
  return background === 119 && level === true && health === 119;
}

test("RuneFrame.xml sits at its stock slot; for a death knight it ends the nil RuneFrame raise at PLAYER_ENTERING_WORLD", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  assert.equal(toc[toc.indexOf("runeframe.xml") - 1], "talentframetemplates.xml", "stock TOC line 138");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.ok(vertical.includes("runeframe.xml"), "RuneFrame.xml is in the vertical");
  assert.deepEqual(vertical.slice(vertical.indexOf("runeframe.xml"), vertical.indexOf("runeframe.xml") + 3),
    // 11.02-F2: VehicleMenuBar.xml (stock line 142) now stands between EasyMenu.lua and AlternatePowerBar.xml.
    ["runeframe.xml", "easymenu.lua", "vehiclemenubar.xml"], "stock lines 138, 139 and 142 in their order");
  let baseline;
  let candidate;
  try {
    baseline = await load(WITHOUT_RUNE_FRAME);
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    // The defect, on the baseline: UnitFrame_SetUnit indexes the nil global for the death knight.
    assert.equal(baseline.boot.bridge.getFrame("RuneFrame")?.name, undefined);
    assert.ok(runeFrameErrors(baseline.inventory).length > 0,
      `the baseline raises on RuneFrame: ${JSON.stringify(baseline.inventory.errors.map(errorKey))}`);
    assert.equal(toPlayerArtReachesItsEnd(baseline.boot), false, "and PlayerFrame_ToPlayerArt stops at its first line");

    assert.ok(candidate.requests.has("interface/framexml/runeframe.lua"), "RuneFrame.lua is reached through its XML");
    assert.deepEqual(runeFrameErrors(candidate.inventory), [], "no RuneFrame raise with the file loaded");
    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    assert.deepEqual(candidate.inventory.errors.filter((error) => !baselineErrors.has(errorKey(error))).map(errorKey), [],
      "no candidate-specific Lua error");
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    // The bytes are the chain's own: TSWoW rewrites RuneFrame.lua's race list from class_has_runes on
    // every `build data`. Both files as the corpus counts them (UTF-8) plus the synthetic TOC's line.
    const utf8 = new TextEncoder();
    let bytes = utf8.encode("RuneFrame.xml\n").byteLength;
    for (const file of ["RuneFrame.xml", "RuneFrame.lua"]) {
      bytes += utf8.encode(decoder.decode(await chain.read(`Interface/FrameXML/${file}`))).byteLength;
    }
    // RuneFrame and six buttons of seven widgets each; one raise fewer — the RuneFrame index the
    // death knight's PLAYER_ENTERING_WORLD made.
    assert.deepEqual(delta, { files: 2, bytes, widgets: 43, errors: -1, distinct: -1, luaFailed: 0 },
      `RuneFrame closure delta ${JSON.stringify(delta)}`);

    const { boot } = candidate;
    assert.equal(boot.bridge.getFrame("RuneFrame")?.type, "Frame");
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((index) => boot.bridge.getFrame(`RuneButtonIndividual${index}`)?.type),
      ["Button", "Button", "Button", "Button", "Button", "Button"]);
    assert.equal(lua(boot, "return RuneFrame:IsShown()")[0], true, "RuneFrame_OnLoad keeps it for a Human death knight");
    // RuneFrame_FixRunes, on the first PLAYER_ENTERING_WORLD, swaps the XML order (ids 1, 2, 5, 6, 3, 4)
    // so that RuneFrame.runes[id] is the button whose id the events carry.
    assert.deepEqual(lua(boot, "local r = {} for k = 1, 6 do r[k] = RuneFrame.runes[k]:GetID() end return unpack(r)", 6),
      [1, 2, 3, 4, 5, 6]);
    assert.equal(lua(boot, "return RuneFrame.runes[5]:GetName()")[0], "RuneButtonIndividual3");
    assert.equal(toPlayerArtReachesItsEnd(boot), true, "PlayerFrame_ToPlayerArt runs to its end");
    assert.deepEqual(lua(boot, "return PetFrame.unit, RuneFrame:GetScale()", 2), ["pet", 1]);
    // The vehicle half of the same branch: PetFrame shows the player and RuneFrame shrinks under it.
    const errors = boot.errorCount;
    lua(boot, 'UnitFrame_SetUnit(PetFrame, "player", PetFrameHealthBar, PetFrameManaBar)', 0);
    assert.ok(Math.abs(lua(boot, "return RuneFrame:GetScale()")[0] - 0.6) < 1e-6, "UnitFrame.lua:73");
    lua(boot, "PlayerFrame_ToPlayerArt(PlayerFrame)", 0);
    assert.deepEqual(lua(boot, "return PetFrame.unit, RuneFrame:GetScale()", 2), ["pet", 1]);
    assert.equal(boot.errorCount, errors);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("the canned death knight's six runes: blood, unholy and frost icons; a spent rune sweeps and returns; a death rune repaints", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  const runes = seam.hudMechanics.runes;
  try {
    const errors = boot.errorCount;
    assert.deepEqual(lua(boot, "return GetRuneType(1), GetRuneType(2), GetRuneType(3), GetRuneType(4), GetRuneType(5), GetRuneType(6), GetRuneType(7)", 7),
      [1, 1, 2, 2, 3, 3, undefined], "Player.cpp runeSlotTypes, one-based");
    const icon = (button) => lua(boot, `return ${button}Rune:GetTexture()`)[0];
    // Visual order left to right: ids 1, 2, 5, 6, 3, 4 — blood, blood, frost, frost, unholy, unholy.
    assert.match(icon("RuneButtonIndividual1"), /Deathknight-Blood/i);
    assert.match(icon("RuneButtonIndividual3"), /Deathknight-Frost/i);
    assert.match(icon("RuneButtonIndividual5"), /Deathknight-Unholy/i);
    assert.deepEqual(lua(boot, "return GetRuneCooldown(3)", 3), [0, 10, true], "ready, and its duration answered");

    // Spend unholy rune 3 (the fifth button): RUNE_POWER_UPDATE(3, false) hangs RuneButton_OnUpdate on it.
    runes.useRune(3);
    assert.equal(lua(boot, "return RuneButtonIndividual5:GetScript('OnUpdate') ~= nil")[0], true);
    boot.bridge.tick(0.016);
    const [start, duration, ready, now] = lua(boot, "local s, d, r = GetRuneCooldown(3) return s, d, r, GetTime()", 4);
    assert.equal(ready, false);
    assert.equal(duration, 10);
    assert.ok(start <= now && now - start < 1, `the sweep starts now: ${start} vs ${now}`);
    assert.equal(lua(boot, "return RuneButtonIndividual5Cooldown:IsShown()")[0], true, "CooldownFrame_SetTimer shows the sweep");
    assert.equal(lua(boot, "return RuneButtonIndividual1:GetScript('OnUpdate') == nil")[0], true, "the other runes stay idle");

    // Back: RUNE_POWER_UPDATE(3, true) shines it, and the next OnUpdate reads it ready and unhooks itself.
    runes.refreshRune(3);
    boot.bridge.tick(0.016);
    assert.deepEqual(lua(boot, "return GetRuneCooldown(3)", 3), [0, 10, true]);
    assert.equal(lua(boot, "return RuneButtonIndividual5:GetScript('OnUpdate') == nil")[0], true);

    // Blood rune 1 becomes a death rune: RUNE_TYPE_UPDATE(1) repaints its icon and tooltip.
    runes.convertRune(1, 3);
    assert.equal(lua(boot, "return GetRuneType(1)")[0], 4);
    assert.match(icon("RuneButtonIndividual1"), /Deathknight-Death/i);
    assert.equal(lua(boot, "return RuneButtonIndividual1.tooltipText == COMBAT_TEXT_RUNE_DEATH")[0], true);
    assert.equal(boot.errorCount, errors, "no Lua error through the whole script");
  } finally {
    boot.close();
  }
});

test("a warrior loads the same RuneFrame hidden and raises nothing it did not raise before", withClient, async () => {
  let baseline;
  let candidate;
  try {
    baseline = await load(WITHOUT_RUNE_FRAME, { deathKnight: false });
    candidate = await load(FRAMEXML_VERTICAL_TOC, { deathKnight: false });
    assert.deepEqual(runeFrameErrors(baseline.inventory), [], "UnitFrame_SetUnit touches RuneFrame only for a death knight");
    assert.equal(candidate.boot.bridge.getFrame("RuneFrame")?.type, "Frame");
    assert.equal(lua(candidate.boot, "return RuneFrame:IsShown()")[0], false, "RuneFrame_OnLoad hides it for other classes");
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    assert.deepEqual({ errors: afterLoad.errors - before.errors, distinct: afterLoad.distinct - before.distinct },
      { errors: 0, distinct: 0 });
    assert.equal(toPlayerArtReachesItsEnd(candidate.boot), true);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("addonsOnly: the death knight's RuneFrame stays loaded but hidden, and its sweeps never tick", withClient, async () => {
  const { hideFrameXmlRuneFrame } = await import("../dist/code/browser/framexml/FrameXmlRunes.js");
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const errors = boot.errorCount;
    assert.equal(lua(boot, "return RuneFrame:IsShown()")[0], true, "stock keeps it for a Human death knight");
    hideFrameXmlRuneFrame(boot);
    assert.deepEqual(lua(boot, "return RuneFrame:IsShown(), RuneButtonIndividual5:IsVisible()", 2), [false, false]);
    // A rune spent after the mount: RuneFrame_OnEvent still hangs RuneButton_OnUpdate on its button,
    // but a hidden frame's OnUpdate does not run, and nothing in the stock files shows it again.
    lua(boot, "__runeTicks = 0 local update = RuneButton_OnUpdate RuneButton_OnUpdate = function(...) __runeTicks = __runeTicks + 1 return update(...) end", 0);
    seam.hudMechanics.runes.useRune(3);
    // RuneFrame's own PLAYER_ENTERING_WORLD repaint (the whole event would also run MainMenuBar.lua,
    // which raises over the canned seam on a second PLAYER_ENTERING_WORLD, unrelated to runes).
    lua(boot, 'RuneFrame_OnEvent(RuneFrame, "PLAYER_ENTERING_WORLD")', 0);
    boot.bridge.tick(0.016);
    boot.bridge.tick(0.016);
    assert.deepEqual(lua(boot, "return RuneFrame:IsShown(), __runeTicks", 2), [false, 0]);
    assert.equal(boot.errorCount, errors);
    // A frame the corpus did not load (another TOC) is not an error.
    hideFrameXmlRuneFrame({ bridge: { getFrame: () => undefined, Hide: () => assert.fail("nothing to hide") } });
  } finally {
    boot.close();
  }
});

test("the world mount hides RuneFrame in the addonsOnly branch before the session events", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/browser/framexml/FrameXmlWorldMount.ts", import.meta.url), "utf8");
  const start = source.indexOf("beforeExercise: (loadedBoot) => {");
  assert.ok(start > 0, "the mount's beforeExercise hook");
  const body = source.slice(start, source.indexOf("\n    },", start));
  assert.match(body, /if \(options\.addonsOnly\) \{\s*(?:\/\/[^\n]*\n\s*)*hideFrameXmlRuneFrame\(loadedBoot\);\s*return;\s*\}/,
    "addonsOnly hides the stock rune bar and returns before the stock HUD adapters");
});

import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock TotemFrame.xml and CombatFeedback.xml in the production vertical over the
// canned seam — the real 3.3.5 TotemFrame.lua, CombatFeedback.lua, PlayerFrame/PetFrame UNIT_COMBAT
// handlers and BuffFrame.lua's TemporaryEnchantFrame against FrameXmlHudMechanics.ts's C API.
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
const { CANNED_TOTEM } = await import("../dist/code/browser/framexml/FrameXmlHudMechanicsCanned.js");
const { FRAMEXML_VERTICAL_TOC, FRAMEXML_TOC_PATH } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const HUD_TOC = Object.freeze(["CombatFeedback.xml", "TotemFrame.xml"]);

async function load(subset, seam = new CannedWorldSeam()) {
  const requests = new Set();
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        requests.add(normalize(path));
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, seam, inventory, requests };
}

/** Run a Lua function body and return its values; a Lua failure raises. */
function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "hud-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

test("CombatFeedback.xml and TotemFrame.xml sit at their stock slots; the closure adds four files and no Lua error", withClient, async () => {
  const toc = parseGlueToc(decoder.decode(await chain.read(FRAMEXML_TOC_PATH)), "interface/framexml/")
    .map((entry) => normalize(entry.path).replace("interface/framexml/", ""));
  assert.equal(toc[toc.indexOf("buffframe.xml") + 1], "combatfeedback.xml", "stock TOC line 64");
  assert.equal(toc[toc.indexOf("targetframe.xml") + 1], "totemframe.xml", "stock TOC line 78");
  const vertical = FRAMEXML_VERTICAL_TOC.map(normalize);
  assert.equal(vertical[vertical.indexOf("buffframe.xml") + 1], "combatfeedback.xml", "the vertical keeps it after BuffFrame");
  assert.equal(vertical[vertical.indexOf("targetframe.xml") + 1], "totemframe.xml", "the vertical keeps it after TargetFrame");
  let baseline;
  let candidate;
  try {
    const hud = new Set(HUD_TOC.map(normalize));
    baseline = await load(FRAMEXML_VERTICAL_TOC.filter((entry) => !hud.has(normalize(entry))));
    candidate = await load(FRAMEXML_VERTICAL_TOC);
    assert.equal(baseline.boot.bridge.getFrame("TotemFrame")?.name, undefined);
    assert.equal(baseline.boot.bridge.getFrame("LowHealthFrame")?.name, undefined);
    for (const file of ["totemframe.lua", "combatfeedback.lua"]) {
      assert.ok(candidate.requests.has(`interface/framexml/${file}`), `${file} is reached through its XML`);
    }
    const metric = (inventory) => ({ files: inventory.files.total, bytes: inventory.files.bytes,
      widgets: inventory.widgets.total, errors: inventory.lua.errorsRaised, distinct: inventory.errors.length,
      luaFailed: inventory.lua.failed });
    const before = metric(baseline.inventory);
    const afterLoad = metric(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, afterLoad[key] - before[key]]));
    assert.deepEqual(delta, { files: 4, bytes: 15025, widgets: 35, errors: 0, distinct: 0, luaFailed: 0 },
      `HUD mechanics closure delta ${JSON.stringify(delta)}`);
    const errorKey = (error) => `${error.file}:${error.line}:${error.message}`;
    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    assert.deepEqual(candidate.inventory.errors.filter((error) => !baselineErrors.has(errorKey(error))), [],
      "no candidate-specific Lua error");
    // TotemFrame_Update and the three CombatFeedback_* functions were reached as nil globals before.
    for (const name of ["TotemFrame_Update", "CombatFeedback_Initialize", "CombatFeedback_OnUpdate", "CombatFeedback_OnCombatEvent"]) {
      assert.equal(lua(candidate.boot, `return type(${name})`)[0], "function", `${name} is corpus-owned`);
    }
    const { boot } = candidate;
    assert.equal(boot.bridge.getFrame("LowHealthFrame").visible, false);
    assert.deepEqual([1, 2, 3, 4].map((index) => boot.bridge.getFrame(`TotemFrameTotem${index}`)?.type), ["Button", "Button", "Button", "Button"]);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("the canned main-hand enchant draws TempEnchant1 (id 16) with its countdown; a right-click cancels it through the seam", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const errors = boot.errorCount;
    // AuraButton_UpdateDuration prints a countdown only under the buffDurations CVar (BuffFrame.lua:254).
    lua(boot, 'SHOW_BUFF_DURATIONS = "1" TemporaryEnchantFrame_OnUpdate(TemporaryEnchantFrame, 0.1)', 0);
    assert.deepEqual(lua(boot, "return TempEnchant1:IsShown(), TempEnchant1:GetID(), TempEnchant2:IsShown(), BuffFrame.numEnchants", 4),
      [true, 16, false, 1], "one main-hand enchant on the first button, the stock inventory id 16");
    const [expiration] = lua(boot, "local _, e = GetWeaponEnchantInfo() return e");
    assert.ok(expiration > 1_790_000 && expiration <= 1_800_000, `thirty minutes in milliseconds: ${expiration}`);
    assert.deepEqual(lua(boot, "return TempEnchant1Duration:IsShown(), TempEnchant1Duration:GetText()", 2),
      [true, lua(boot, "return format(SecondsToTimeAbbrev(1800))")[0]], "the countdown text reads the thirty minutes");
    lua(boot, 'TempEnchantButton_OnClick(TempEnchant1, "RightButton")', 0);
    assert.deepEqual(seam.hudMechanics.calls, ["CancelTempEnchantment:15"], "the stock 1 became equipment slot 15");
    lua(boot, "TemporaryEnchantFrame_OnUpdate(TemporaryEnchantFrame, 0.1)", 0);
    assert.deepEqual(lua(boot, "return TempEnchant1:IsShown(), BuffFrame.numEnchants", 2), [false, 0]);
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});

test("the canned earth totem fills TotemFrameTotem1 for a shaman, counts down, and a right-click destroys it", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    // The canned player is a warrior with a pet, and TotemFrame_Update hides the bar for that class
    // while PetFrame is shown, as the client does. UnitClass is read at every update, so a shaman
    // from here on is enough to draw it.
    assert.equal(boot.bridge.getFrame("TotemFrame").visible, false, "hidden for the warrior with a pet");
    seam.setPlayerClass("Шаман", "SHAMAN");
    const errors = boot.errorCount;
    lua(boot, "TotemFrame_Update()", 0);
    assert.deepEqual(lua(boot, "return TotemFrame:IsShown(), TotemFrame.activeTotems, TotemFrameTotem1:IsShown(), TotemFrameTotem1.slot, TotemFrameTotem2:IsShown()", 5),
      [true, 1, true, CANNED_TOTEM.slot, false], "TOTEM_PRIORITIES puts the earth totem on the first button");
    assert.equal(lua(boot, "return TotemFrameTotem1IconTexture:GetTexture()")[0], CANNED_TOTEM.icon);
    // TotemButton_OnUpdate hands GetTotemTimeLeft to AuraButton_UpdateDuration, which prints it only
    // under the buffDurations CVar (BuffFrame.lua:254).
    lua(boot, 'SHOW_BUFF_DURATIONS = "1"', 0);
    boot.bridge.tick(0.016);
    assert.equal(lua(boot, "return GetTotemTimeLeft(TotemFrameTotem1.slot)")[0], CANNED_TOTEM.duration);
    assert.deepEqual(lua(boot, "return TotemFrameTotem1Duration:IsShown(), TotemFrameTotem1Duration:GetText()", 2),
      [true, lua(boot, `return format(SecondsToTimeAbbrev(${CANNED_TOTEM.duration}))`)[0]], "the button prints the time left");
    lua(boot, 'TotemButton_OnClick(TotemFrameTotem1, "RightButton")', 0);
    assert.deepEqual(seam.hudMechanics.calls, [`DestroyTotem:${CANNED_TOTEM.slot - 1}`], "the client's slot 2 is the wire's slot 1");
    // The canned world empties the slot at once and fires PLAYER_TOTEM_UPDATE(slot): the frame goes down.
    assert.deepEqual(lua(boot, "return TotemFrame:IsShown(), TotemFrame.activeTotems, TotemFrameTotem1:IsShown()", 3), [false, 0, false]);
    // A recast into the slot brings it back through the same event.
    seam.hudMechanics.placeTotem(CANNED_TOTEM);
    assert.deepEqual(lua(boot, "return TotemFrame:IsShown(), TotemFrame.activeTotems, TotemFrameTotem1:IsShown()", 3), [true, 1, true]);
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});

test("UNIT_COMBAT paints the stock hit indicators: a crit on the player, a heal on the pet, a dodge worded", withClient, async () => {
  const { boot, seam } = await load(FRAMEXML_VERTICAL_TOC);
  try {
    const errors = boot.errorCount;
    seam.hudMechanics.hit("player", "WOUND", "CRITICAL", 1234, 1);
    assert.deepEqual(lua(boot, "return PlayerHitIndicator:IsShown(), PlayerHitIndicator:GetText(), PlayerHitIndicator:GetAlpha()", 3),
      [true, "1234", 0], "shown at alpha 0, the fade-in is CombatFeedback_OnUpdate's");
    boot.bridge.tick(0.1);
    const [alpha] = lua(boot, "return PlayerHitIndicator:GetAlpha()");
    assert.ok(alpha > 0 && alpha <= 1, `fading in after one frame: ${alpha}`);
    seam.hudMechanics.hit("player", "WOUND", "", 0, 1);
    assert.equal(lua(boot, "return PlayerHitIndicator:GetText()")[0], lua(boot, "return MISS")[0], "a zero wound reads MISS");
    seam.hudMechanics.hit("player", "DODGE", "", 0, 1);
    assert.equal(lua(boot, "return PlayerHitIndicator:GetText()")[0], lua(boot, "return DODGE")[0]);
    seam.hudMechanics.hit("pet", "HEAL", "CRITICAL", 321, 0);
    assert.deepEqual(lua(boot, "return PetHitIndicator:IsShown(), PetHitIndicator:GetText()", 2), [true, "321"]);
    seam.hudMechanics.hit("target", "WOUND", "", 55, 1);
    assert.equal(lua(boot, "return PlayerHitIndicator:GetText()")[0], lua(boot, "return DODGE")[0],
      "the target has no indicator in 3.3.5, and the player's is untouched");
    assert.equal(boot.errorCount, errors);
  } finally {
    boot.close();
  }
});

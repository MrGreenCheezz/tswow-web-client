import assert from "node:assert/strict";
import { after } from "node:test";
import test from "node:test";

// MPQ-backed on purpose: PaperDollFrame.lua, CharacterFrame.xml, Minimap.xml and ChatFrame.lua must
// be the client's own, since the failures these pin were raised by that stock code.
let clientDirectory;
try {
  clientDirectory = (await import("../tools/paths.mjs")).clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { LiveWorldSeam } = await import("../dist/code/browser/framexml/LiveWorldSeam.js");
const { frameXmlEscapeLocalChatText } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { parseFrameXmlText } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlText.js");
const { forgetCreationNames, learnCreationNames } = await import("../dist/code/browser/ui/UnitSnapshot.js");
const { UPDATE_FIELDS } = await import("../dist/code/generated/updateFields.js");

const decoder = new TextDecoder("utf-8");
let chain;
async function provider() {
  if (!chain) {
    const { clientArchives } = await import("../tools/mpq.mjs");
    chain = await clientArchives(clientDirectory);
  }
  return {
    async read(path) {
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
}
after(() => chain?.close?.());

function lua(boot, source, results = 1) {
  const chunk = boot.vm.compileFunction(source, "@custom-class", []);
  try { return boot.vm.call(chunk, [], results); } finally { boot.vm.release(chunk); }
}

const STAT_ROWS = [1, 2, 3, 4, 5, 6].flatMap((index) => [`PlayerStatFrameLeft${index}`, `PlayerStatFrameRight${index}`]);

function statRows(boot) {
  return STAT_ROWS.map((name) => [
    name,
    boot.bridge.getFrame(`${name}Label`)?.text ?? "",
    boot.bridge.getFrame(`${name}StatText`)?.text ?? "",
  ]);
}

/** Open CharacterFrame the stock way and return the handled-error delta that produced. */
function openCharacter(boot) {
  const [before] = lua(boot, "return _ERROR_COUNT or 0");
  lua(boot, `ToggleCharacter("PaperDollFrame") return true`);
  const [afterOpen] = lua(boot, "return _ERROR_COUNT or 0");
  return Number(afterOpen) - Number(before);
}

test("a TSWoW class fills all twelve stat rows and names itself on the level line (canned)", withClient, async () => {
  const seam = new CannedWorldSeam();
  seam.setPlayerClass("Герой", "HERO");
  const boot = new FrameXmlBoot({
    provider: await provider(), locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    assert.equal(openCharacter(boot), 0, "opening the paper doll raises nothing");
    for (const [name, label, value] of statRows(boot)) {
      assert.ok(label.length > 0 && value.length > 0, `${name} is filled: [${label}] [${value}]`);
    }
    const level = boot.bridge.getFrame("CharacterLevelText").text;
    const shown = parseFrameXmlText(level).map((run) => run.text).join("");
    assert.equal(shown, "Человек, Герой 60-го уровня", `level line: ${level}`);
    const [before] = lua(boot, "return _ERROR_COUNT or 0");
    lua(boot, "PaperDollFrame_UpdateStats() PaperDollFrame_SetLevel() return true");
    const [afterUpdate] = lua(boot, "return _ERROR_COUNT or 0");
    assert.equal(afterUpdate, before, "stat refreshes stay error-free");
  } finally {
    boot.close();
  }
});

test("the live seam gives a learned class 13 player a complete paper doll", withClient, async () => {
  forgetCreationNames();
  learnCreationNames(
    [{ id: 1, name: "Человек", clientFileString: "Human", baseLanguage: 7 }],
    [{ id: 13, name: "Герой", fileName: "HERO" },
      { id: 3, name: "Охотник", nameMale: "Охотник", nameFemale: "Охотница", fileName: "HUNTER" }],
  );
  const fields = new Map();
  const set = (name, value, index = 0) => fields.set(UPDATE_FIELDS[name].offset + index, value >>> 0);
  set("UNIT_FIELD_BYTES_0", 1 | (13 << 8)); // human HERO, as on the owner's character
  set("UNIT_FIELD_LEVEL", 80);
  set("UNIT_FIELD_MAXPOWER1", 5000);
  for (let stat = 0; stat < 5; stat++) set("UNIT_FIELD_STAT0", 100 + stat, stat);
  set("UNIT_FIELD_RESISTANCES", 500);
  const selfGuid = 1n;
  const world = {
    state: { selfGuid, objects: new Map([[selfGuid, { guid: selfGuid, typeId: 4, fields }]]) },
    actionButtons: [], casts: new Map(), channels: new Map(), events: { on: () => () => {} },
    itemTemplates: new Map(), cooldownRemaining: () => 0, names: new Map(), creatureTemplates: new Map(),
    partyStats: new Map(), knownSpells: [],
  };
  const seam = new LiveWorldSeam({
    world: () => world, store: () => undefined, spell: () => undefined,
    monotonic: () => 0, globalCooldownUntil: () => 0, castSpell: () => {},
  });
  const boot = new FrameXmlBoot({
    provider: await provider(), locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const opened = openCharacter(boot);
    assert.equal(opened, 0, "no strupper(nil) and no _format(nil) while opening");
    for (const [name, label, value] of statRows(boot)) {
      assert.ok(label.length > 0 && value.length > 0, `${name} is filled: [${label}] [${value}]`);
    }
    const shown = parseFrameXmlText(boot.bridge.getFrame("CharacterLevelText").text).map((run) => run.text).join("");
    assert.equal(shown, "Человек, Герой 80-го уровня");
    // Constants.lua:91-92 filled both lists at load from the learned classes (9.05): HERO past 11,
    // the female column for the hunter, and this corpus's own class count.
    assert.deepEqual(lua(boot, `return LOCALIZED_CLASS_NAMES_MALE.HERO, LOCALIZED_CLASS_NAMES_FEMALE.HERO,
      LOCALIZED_CLASS_NAMES_MALE.HUNTER, LOCALIZED_CLASS_NAMES_FEMALE.HUNTER, MAX_CLASSES`, 5),
    ["Герой", "Герой", "Охотник", "Охотница", 12]);
  } finally {
    boot.close();
    forgetCreationNames();
  }
});

test("character tabs, minimap indicators, map pins, CVars and chat text answer like the client", withClient, async () => {
  const sent = [];
  const seam = new CannedWorldSeam(undefined, (...args) => sent.push(args));
  const boot = new FrameXmlBoot({
    provider: await provider(), locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  try {
    await boot.load();
    const errorsAtStart = Number(lua(boot, "return _ERROR_COUNT or 0")[0]);

    // B13: the pet tab's geometry is stock PetPaperDollFrame_UpdateIsAvailable's (PetPaperDollFrame.lua:52-66),
    // evaluated once after the session events (FrameXmlBoot.ts). The canned character has a hunter
    // pet and companions, so tab 2 is shown and tab 3 sits at its RIGHT at -16 (:63). The hidden
    // case's visibility (no pet, no companions: tab 2 hidden) is framexml-character-vertical.test.mjs's;
    // its anchor — Tab3 LEFT to Tab2's LEFT, no one-tab gap — is not pinned by any test yet. The
    // Companions/Mounts sub-tabs are driven by framexml-pet-companions-vertical.test.mjs.
    assert.equal(boot.bridge.getFrame("CharacterFrameTab2")?.visible, true, "the canned hunter has a pet page");
    assert.deepEqual(lua(boot, `
      local point, relativeTo, relativePoint, x, y = CharacterFrameTab3:GetPoint(1)
      return point, relativeTo and relativeTo:GetName(), relativePoint, x, y`, 5),
    ["LEFT", "CharacterFrameTab2", "RIGHT", -16, 0]);

    // B5: no phantom PvP queue icon, a load-time expansion level, the map and clock CVars.
    assert.deepEqual(lua(boot, "return GetWorldPVPQueueStatus(1)"), ["none"]);
    assert.deepEqual(lua(boot, "return MiniMapBattlefieldFrame:IsShown()"), [false]);
    assert.deepEqual(lua(boot, "return GetExpansionLevel()"), [2]);
    assert.deepEqual(lua(boot, `return GetCVar("worldMapOpacity"), GetCVar("questPOI"), GetCVar("timeMgrUseMilitaryTime")`, 3),
      ["0", "1", "1"]);
    assert.deepEqual(lua(boot, `return UnitLevel("boss1")`), [0]);

    // B7: the seam shadows the neutral GetNumTrackingTypes = 0 and drives the stock button.
    assert.deepEqual(lua(boot, "return GetNumTrackingTypes()"), [2]);
    assert.deepEqual(lua(boot, "return GetTrackingInfo(2)", 4),
      ["Поиск минералов", "Interface\\Icons\\Spell_Nature_Earthquake", false, "spell"]);
    lua(boot, "SetTracking(1) return true");
    assert.deepEqual(seam.trackingRequests, [2383]);
    assert.deepEqual(lua(boot, "return MiniMapTrackingIcon:GetTexture()"), ["Interface\\Icons\\INV_Misc_Flower_02"],
      "MINIMAP_UPDATE_TRACKING ran MiniMapTracking_Update");

    // B14: the canned player is alive, so the corpse pin is the stock (0, 0) sentinel.
    assert.deepEqual(lua(boot, "return GetCorpseMapPosition()", 2), [0, 0]);
    assert.deepEqual(lua(boot, "return GetNumBattlefields()"), [0]);

    // B3/B9: GUIDs and the canned mouseover alias through the real Lua globals.
    assert.deepEqual(lua(boot, `return UnitGUID("player")`), ["0x0000000000000001"]);
    seam.setMouseover("party1");
    assert.deepEqual(lua(boot, `return UnitName("mouseover"), UnitIsUnit("mouseover", "party1")`, 2), ["Альфа", true]);

    // B11/B12: the player's own language and the language menu, and /afk's empty message.
    assert.deepEqual(lua(boot, "return GetDefaultLanguage(), GetNumLanguages()", 2), ["всеобщий", 1]);
    lua(boot, `SendChatMessage("", "AFK") return true`);
    assert.deepEqual(sent.at(-1), ["", 0x17, undefined, ""]);

    // B10: an escaped client line reaches ChatFrame1 as one line that reads as written.
    const help = "/vehicle enter|leave|next|prev|eject — транспорт";
    boot.pump.fire("CHAT_MSG_SYSTEM", frameXmlEscapeLocalChatText(help), "", "", "", "", "", 0, 0, "", 0, 99, "");
    const messages = boot.bridge.getFrame("ChatFrame1").messageFrame.messages;
    const last = messages.at(-1).text;
    assert.equal(parseFrameXmlText(last, true).map((run) => run.text).join(""), help);

    assert.equal(Number(lua(boot, "return _ERROR_COUNT or 0")[0]), errorsAtStart, "none of this raised");
  } finally {
    boot.close();
  }
});

import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock character window's «Питомцы» tab (PetPaperDollFrame.xml/.lua in the vertical)
// driven only through its own buttons over the canned seam's companions (FrameXmlCompanionsCanned.ts:
// the mounts 458/580, the critter 4055). CharacterFrameTab2 opens the page, PetPaperDollFrameTab2/Tab3
// switch the «Спутники»/«Транспорт» sub-tabs, the twelve CompanionButtons show GetCompanionInfo's
// entries in the model's order (by name: the wolf 580 before the horse 458), a CompanionButton pick and
// CompanionSummonButton reach the stand-in realm (`companionWorld.sent`), and the realm's summon flips
// that button's text as stock PetPaperDollFrame_UpdateCompanions does — 0 new Lua errors throughout.
// The tab's own geometry is tests/framexml-custom-class-vertical.test.mjs's (B13), the C API
// tests/framexml-companions.test.mjs's.
//
// Memory rule (docs/parity/handoff-2026-09-28.ru.md): no bridge frame ever reaches an assert — only
// the primitives read off one (`?.enabled`, texture paths, Lua return values).
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
const { createFrameXmlSettingsCVar } = await import("../dist/code/browser/framexml/FrameXmlSettingsCVar.js");
const { defaultSettings } = await import("../dist/code/browser/ui/SettingsModel.js");
const { CANNED_COMPANION_CRITTER_GUID } = await import("../dist/code/browser/framexml/FrameXmlCompanionsCanned.js");
const decoder = new TextDecoder("utf-8");

/** PetPaperDollFrame.lua:3. */
const NUM_COMPANIONS_PER_PAGE = 12;
/** ruRU GlobalStrings.lua: the sub-tabs' labels (PetPaperDollFrame.xml:915-980) and the summon button's four texts (:411-413). */
const TEXT = Object.freeze({
  PET: "Питомец",
  COMPANIONS: "Спутники",
  MOUNTS: "Транспорт",
  SUMMON: "Призвать",
  PET_DISMISS: "Отпустить",
  MOUNT: "Оседлать",
  BINDING_NAME_DISMOUNT: "Спешиться",
});
/** The empty slot's art per sub-tab: PetPaperDollFrame_SetTab's SetDisabledTexture (:206, :218). */
const SLOT = Object.freeze({
  CRITTER: "Interface\\PetPaperDollFrame\\UI-PetFrame-Slots-Companions",
  MOUNT: "Interface\\PetPaperDollFrame\\UI-PetFrame-Slots-Mounts",
});
/**
 * GetCompanionInfo's `creatureID, spellID, icon` and the name CompanionSelectedName shows, per
 * button, in the order the page lists them: the canned rows (FrameXmlCompanionsCanned.ts, measured),
 * the mounts by the locale's collation of their names — «Большой лесной волк» (580) before
 * «Гнедой конь» (458), the reverse of the ids. Literal on purpose: the order is what this pins.
 */
const CRITTERS = Object.freeze([[2671, 4055, "Interface\\Icons\\INV_Crate_01", "Механическая белка"]]);
const MOUNTS = Object.freeze([
  [358, 580, "Interface\\Icons\\Ability_Mount_BlackDireWolf", "Большой лесной волк"],
  [284, 458, "Interface\\Icons\\Ability_Mount_RidingHorse", "Гнедой конь"],
]);

async function load() {
  let values = defaultSettings();
  const cvars = createFrameXmlSettingsCVar({
    getSettings: () => values,
    setSetting: (id, value) => { values = { ...values, [id]: value }; },
  });
  const seam = new CannedWorldSeam(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, cvars);
  const reads = [];
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        if (data) reads.push(path.replaceAll("\\", "/").toLowerCase());
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  await boot.load();
  return { boot, seam, reads };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "pet-companions-test", []);
  assert.ok(fn !== undefined, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** Effective visibility of a named frame or region; undefined when it does not exist. */
function shown(boot, name) {
  const found = boot.bridge.getFrame(name);
  return found ? boot.bridge.isVisible(found) : undefined;
}

/**
 * Every grouped failure (`file:line message`) with its count, to diff against the scenario's start.
 * The boot keeps a failure's first line only, so an error a JS binding raised has no Lua position;
 * the click that raised it is named by `click` instead.
 */
const failureCounts = (boot) => new Map(boot.errors.map((failure) => [
  `${failure.file ? `${failure.file}:${failure.line}` : "(no Lua position)"} ${failure.message}`, failure.count,
]));

/** The scenario's error baseline, taken once the boot is up. */
const errorGuard = (boot) => ({ count: boot.errorCount, failures: failureCounts(boot) });

/** 0 new Lua errors since the baseline; on failure the message lists each new one with its file:line. */
function assertNoNewErrors(boot, guard, where) {
  if (boot.errorCount === guard.count) return;
  const added = [];
  for (const [failure, count] of failureCounts(boot)) {
    const was = guard.failures.get(failure) ?? 0;
    if (count > was) added.push(`  ${failure} (x${count - was})`);
  }
  assert.fail(`${where}: ${boot.errorCount - guard.count} new Lua error(s)\n${added.join("\n")}`);
}

/** A stock button's own click (`Button:Click()`, its OnClick with "LeftButton"), then the error guard. */
function click(boot, guard, name) {
  lua(boot, `${name}:Click()`, 0);
  assertNoNewErrors(boot, guard, `${name}:Click()`);
}

/** What the stock page put on its twelve CompanionButtons, as primitives only. */
function companionButtons(boot) {
  const rows = [];
  for (let index = 1; index <= NUM_COMPANIONS_PER_PAGE; index += 1) {
    const name = `CompanionButton${index}`;
    const button = boot.bridge.getFrame(name);
    const [creatureID, spellID, active] = lua(boot, `return ${name}.creatureID, ${name}.spellID, ${name}.active`, 3);
    rows.push({
      creatureID,
      spellID,
      active,
      enabled: button?.enabled === true,
      checked: button?.checked === true,
      icon: button?.stateTextures.get("NORMAL")?.texture,
      slot: button?.stateTextures.get("DISABLED")?.texture,
      glow: shown(boot, `${name}ActiveTexture`),
    });
  }
  return rows;
}

/** The sub-tab PetPaperDollFrame_SetTab chose: its mode, the page title, and PanelTemplates' selection. */
function assertSubTab(boot, label, mode, tab, title) {
  assert.deepEqual(lua(boot, "return PetPaperDollFrameCompanionFrame.mode, PetPaperDollFrame.selectedTab, PetNameText:GetText()", 3),
    [mode, tab, title], `${label}: mode, selected sub-tab, page title`);
  assert.equal(shown(boot, "PetPaperDollFrameCompanionFrame"), true, `${label}: the companion page shows`);
  assert.equal(shown(boot, "PetPaperDollFramePetFrame"), false, `${label}: the pet's own page hides`);
  // PanelTemplates_SelectTab disables the chosen tab; the other two stay clickable.
  assert.deepEqual([1, 2, 3].map((id) => boot.bridge.getFrame(`PetPaperDollFrameTab${id}`)?.enabled),
    [1, 2, 3].map((id) => id !== tab), `${label}: only the chosen sub-tab is disabled`);
}

/** The listed entries in button order, then the empty slots PetPaperDollFrame_UpdateCompanions disabled. */
function assertPage(boot, label, entries, slot) {
  const rows = companionButtons(boot);
  entries.forEach(([creatureID, spellID, icon], index) => {
    const row = rows[index];
    assert.deepEqual([row.creatureID, row.spellID, row.icon, row.enabled, row.active, row.glow], [creatureID, spellID, icon, true, false, false],
      `${label}: CompanionButton${index + 1} is GetCompanionInfo(mode, ${index + 1})`);
  });
  for (let index = entries.length; index < rows.length; index += 1) {
    const row = rows[index];
    assert.deepEqual([row.creatureID, row.spellID, row.enabled, row.checked, row.glow, row.slot],
      [undefined, undefined, false, false, false, slot], `${label}: CompanionButton${index + 1} is an empty, disabled slot`);
  }
  assert.deepEqual(lua(boot, "return CompanionPageNumber:GetText()"), ["Страница 1 из 1"], `${label}: MERCHANT_PAGE_NUMBER, one page`);
  assert.deepEqual(["CompanionPrevPageButton", "CompanionNextPageButton"].map((name) => boot.bridge.getFrame(name)?.enabled), [false, false],
    `${label}: no other page to turn to`);
}

/** The selection: the one checked button, its name under the model and the preview's creature. */
function assertSelected(boot, label, index, name, creatureID) {
  const checked = companionButtons(boot).map((row) => row.checked);
  assert.deepEqual(checked, checked.map((_, at) => at === index - 1), `${label}: only CompanionButton${index} is checked`);
  assert.deepEqual(lua(boot, "return CompanionSelectedName:GetText()"), [name], `${label}: CompanionSelectedName`);
  assert.equal(boot.bridge.getFrame("CompanionModelFrame")?.model?.creatureEntry, creatureID, `${label}: CompanionModelFrame:SetCreature`);
}

const summonText = (boot) => lua(boot, "return CompanionSummonButton:GetText()")[0];

test("CharacterFrameTab2 opens the pet page and its «Спутники»/«Транспорт» sub-tabs list the canned companions in the model's order", withClient, async () => {
  const { boot, seam, reads } = await load();
  try {
    assert.ok(reads.includes("interface/framexml/petpaperdollframe.lua"), "the stock page is read from the MPQ chain");
    const guard = errorGuard(boot);
    assert.deepEqual(lua(boot, "return PET, COMPANIONS, MOUNTS, SUMMON, PET_DISMISS, MOUNT, BINDING_NAME_DISMOUNT", 7),
      [TEXT.PET, TEXT.COMPANIONS, TEXT.MOUNTS, TEXT.SUMMON, TEXT.PET_DISMISS, TEXT.MOUNT, TEXT.BINDING_NAME_DISMOUNT], "ruRU GlobalStrings");

    lua(boot, "ShowUIPanel(CharacterFrame)", 0);
    assertNoNewErrors(boot, guard, "ShowUIPanel(CharacterFrame)");
    assert.equal(shown(boot, "PaperDollFrame"), true);
    assert.equal(shown(boot, "CharacterFrameTab2"), true, "the canned hunter's pet and companions keep the «Питомцы» tab");
    click(boot, guard, "CharacterFrameTab2");
    assert.equal(shown(boot, "PetPaperDollFrame"), true, "CharacterFrameTab_OnClick → ToggleCharacter('PetPaperDollFrame')");
    assert.equal(shown(boot, "PaperDollFrame"), false);
    assert.deepEqual(lua(boot, "return PanelTemplates_GetSelectedTab(CharacterFrame)"), [2]);
    // PetPaperDollFrame_UpdateTabs: a pet and both kinds, so all three sub-tabs; the first view is the pet's own page.
    assert.deepEqual(["PetPaperDollFrameTab1", "PetPaperDollFrameTab2", "PetPaperDollFrameTab3"].map((name) => shown(boot, name)),
      [true, true, true]);
    assert.deepEqual(lua(boot, "return PetPaperDollFrameTab1:GetText(), PetPaperDollFrameTab2:GetText(), PetPaperDollFrameTab3:GetText()", 3),
      [TEXT.PET, TEXT.COMPANIONS, TEXT.MOUNTS]);
    assert.equal(shown(boot, "PetPaperDollFramePetFrame"), true);
    assert.equal(shown(boot, "PetPaperDollFrameCompanionFrame"), false);

    click(boot, guard, "PetPaperDollFrameTab2");
    assertSubTab(boot, "«Спутники»", "CRITTER", 2, TEXT.COMPANIONS);
    assertPage(boot, "«Спутники»", CRITTERS, SLOT.CRITTER);
    // COMPANION_UPDATE at attach filled idCritter with the first critter: the page opens on it.
    assertSelected(boot, "«Спутники»", 1, CRITTERS[0][3], CRITTERS[0][0]);
    assert.equal(summonText(boot), TEXT.SUMMON);

    click(boot, guard, "PetPaperDollFrameTab3");
    assertSubTab(boot, "«Транспорт»", "MOUNT", 3, TEXT.MOUNTS);
    assertPage(boot, "«Транспорт»", MOUNTS, SLOT.MOUNT);
    assertSelected(boot, "«Транспорт»", 1, MOUNTS[0][3], MOUNTS[0][0]);
    assert.equal(summonText(boot), TEXT.MOUNT);
    // The page names an entry under the model once it is picked: each mount's name, in list order.
    click(boot, guard, "CompanionButton2");
    assertSelected(boot, "«Транспорт», the second entry", 2, MOUNTS[1][3], MOUNTS[1][0]);
    click(boot, guard, "CompanionButton1");
    assertSelected(boot, "«Транспорт», the first again", 1, MOUNTS[0][3], MOUNTS[0][0]);

    // Back: the horse's slot is empty again and wears the companions' slot art.
    click(boot, guard, "PetPaperDollFrameTab2");
    assertSubTab(boot, "«Спутники» again", "CRITTER", 2, TEXT.COMPANIONS);
    assertPage(boot, "«Спутники» again", CRITTERS, SLOT.CRITTER);
    assertSelected(boot, "«Спутники» again", 1, CRITTERS[0][3], CRITTERS[0][0]);

    assert.deepEqual(seam.companionWorld.sent, [], "browsing the page asks the realm nothing");
    assertNoNewErrors(boot, guard, "the whole scenario");
  } finally {
    boot.close();
  }
});

test("a CompanionButton pick and CompanionSummonButton call and dismiss through the stand-in realm, and the button follows the realm's summon", withClient, async () => {
  const { boot, seam } = await load();
  const world = seam.companionWorld;
  try {
    const guard = errorGuard(boot);
    lua(boot, "ShowUIPanel(CharacterFrame)", 0);
    assertNoNewErrors(boot, guard, "ShowUIPanel(CharacterFrame)");
    click(boot, guard, "CharacterFrameTab2");
    click(boot, guard, "PetPaperDollFrameTab3");
    assertSubTab(boot, "«Транспорт»", "MOUNT", 3, TEXT.MOUNTS);

    // A left click on another button only selects it (CompanionButton_OnClick's else branch).
    click(boot, guard, "CompanionButton2");
    assert.deepEqual(world.sent, [], "a pick is not a summon");
    assertSelected(boot, "the horse picked", 2, MOUNTS[1][3], MOUNTS[1][0]);
    assert.equal(summonText(boot), TEXT.MOUNT);

    // CompanionSummonButton_OnClick: the selection is not out → CallCompanion("MOUNT", 2).
    click(boot, guard, "CompanionSummonButton");
    assert.deepEqual(world.sent, [["cast", 458]], "CallCompanion reached the realm with the horse's spell");
    assert.equal(world.mounted(), 458, "the realm mounted the player");
    // The realm's COMPANION_UPDATE("MOUNT") → PetPaperDollFrame_UpdateCompanions: the glow and the dismount text.
    assert.equal(summonText(boot), TEXT.BINDING_NAME_DISMOUNT);
    assert.deepEqual(companionButtons(boot).slice(0, 2).map((row) => [row.active, row.glow]), [[false, false], [true, true]]);

    // Out → DismissCompanion("MOUNT"): the worn mount's spell again, the client's dismount.
    click(boot, guard, "CompanionSummonButton");
    assert.deepEqual(world.sent, [["cast", 458], ["cast", 458]]);
    assert.equal(world.mounted(), undefined, "the realm dismounted the player");
    assert.equal(summonText(boot), TEXT.MOUNT);
    assert.deepEqual(companionButtons(boot).slice(0, 2).map((row) => [row.active, row.glow]), [[false, false], [false, false]]);

    // «Спутники»: the squirrel is the page's selection; CRITTER's own texts.
    click(boot, guard, "PetPaperDollFrameTab2");
    assertSubTab(boot, "«Спутники»", "CRITTER", 2, TEXT.COMPANIONS);
    assert.equal(summonText(boot), TEXT.SUMMON);
    click(boot, guard, "CompanionSummonButton");
    assert.deepEqual(world.sent.slice(2), [["cast", 4055]], "CallCompanion('CRITTER', 1)");
    assert.equal(world.critterOut(), 4055, "the realm put the squirrel in view");
    assert.equal(summonText(boot), TEXT.PET_DISMISS);
    const [out] = companionButtons(boot);
    assert.deepEqual([out.active, out.glow], [true, true]);
    click(boot, guard, "CompanionSummonButton");
    assert.deepEqual(world.sent.slice(3), [["dismiss", CANNED_COMPANION_CRITTER_GUID]],
      "DismissCompanion('CRITTER') → CMSG_DISMISS_CRITTER with the unit in view");
    assert.equal(world.critterOut(), undefined);
    assert.equal(summonText(boot), TEXT.SUMMON);
    const [back] = companionButtons(boot);
    assert.deepEqual([back.active, back.glow], [false, false]);

    assertNoNewErrors(boot, guard, "the whole scenario");
  } finally {
    boot.close();
  }
});

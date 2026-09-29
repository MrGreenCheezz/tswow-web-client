import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the real load-on-demand Blizzard_AchievementUI and the stock AlertFrames.xml over the
// production vertical and the canned achievements (FrameXmlAchievementCanned.ts, dataset catalog
// rows). The add-on is loaded the way the world mount loads it — the lazy owner's catalog, the alert
// frames, boot.loadAddon, the gate and the `owned` edge — and then driven through the stock Lua: the
// summary, a category's rows and objectives, statistics, the toast, tracking into the WatchFrame and
// the comparison; a first load that leaves the player's open panels alone, a catalog the gateway does
// not serve yet, the chat link's tooltip and a progress-bar achievement over hidden criteria.
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

function fakeNode() {
  return {
    children: [], style: {}, dataset: {}, hidden: false, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    append() {}, replaceChildren() {}, remove() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; }, getContext() { return {}; },
    querySelector(selector) { return selector === 'button[type="submit"]' ? fakeNode() : null; },
  };
}
globalThis.document ??= {
  head: fakeNode(), body: fakeNode(), createElement: fakeNode, getElementById: fakeNode, querySelectorAll() { return []; },
};
globalThis.window ??= {
  innerWidth: 1024, innerHeight: 768, location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
};
globalThis.location ??= globalThis.window.location;
globalThis.localStorage ??= { getItem() { return null; }, setItem() {} };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const {
  createLazyFrameXmlAchievementOwner, installFrameXmlAchievementHostGlobals, installFrameXmlAchievementLinkTooltip,
  frameXmlAchievementGate, FRAMEXML_ACHIEVEMENT_ADDON,
} = await import("../dist/code/browser/framexml/FrameXmlAchievementOwner.js");
const { FrameXmlAchievementCatalog } = await import("../dist/code/browser/framexml/FrameXmlAchievementCatalog.js");
const { FRAMEXML_ACHIEVEMENT_CANNED_CATALOG } = await import("../dist/code/browser/framexml/FrameXmlAchievementCannedData.js");
const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_achievementui/";
const ALERT_FILES = ["interface/framexml/alertframes.lua", "interface/framexml/alertframes.xml"];
const GOLD = "|TInterface\\MoneyFrame\\UI-GoldIcon:0:0:2:0|t";
const SILVER = "|TInterface\\MoneyFrame\\UI-SilverIcon:0:0:2:0|t";
const COPPER = "|TInterface\\MoneyFrame\\UI-CopperIcon:0:0:2:0|t";

async function load({ missingAddon = false, catalog = true } = {}) {
  const requests = [];
  const seam = new CannedWorldSeam();
  // Without a catalog the gateway answers 404 until `gateway.serving` is set (the owner restarted it).
  const gateway = { serving: catalog };
  if (!catalog) {
    const canned = seam.achievement.catalogSource;
    seam.achievement.catalogSource = {
      failure: "achievement catalog gateway returned 404",
      load: () => gateway.serving ? canned.load() : Promise.resolve(undefined),
    };
  }
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalize(path);
        requests.push(key);
        if (missingAddon && key.startsWith(ADDON_PREFIX)) return undefined;
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: true, screen: () => ({ width: 1365, height: 768 }),
  });
  const started = performance.now();
  const inventory = await boot.load();
  return { boot, seam, requests, inventory, gateway, loadMs: performance.now() - started };
}

/** A renderer stand-in whose element tree mirrors the frame tree, as FrameXmlDomRenderer's does. */
function treeRenderer() {
  const elements = new Map();
  const elementFor = (frame) => {
    if (!frame) return null;
    if (!elements.has(frame)) {
      const attributes = new Map([["data-framexml-name", frame.name], ["data-framexml-type", frame.type]]);
      elements.set(frame, { dataset: {}, get parentElement() { return elementFor(frame.parent); }, getAttribute: (name) => attributes.get(name) ?? null });
    }
    return elements.get(frame);
  };
  return { elementFor, addRoots() {}, sync() {} };
}

function lua(boot, code, results = 1) {
  const fn = boot.vm.compileFunction(code, "achievement-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return boot.vm.call(fn, [], results); } finally { boot.vm.release(fn); }
}

/** The world mount's route: the lazy owner, stock's LoD entry points, then the micro button's toggle. */
async function openWindow(loaded, renderer = treeRenderer()) {
  const failures = [];
  const owner = createLazyFrameXmlAchievementOwner(loaded.seam, loaded.boot, renderer, {
    onFailure: (reason, requested) => failures.push({ reason, requested }),
  });
  installFrameXmlAchievementHostGlobals(loaded.boot, {
    toggle: (stats) => { owner.toggle(stats); }, load: () => { owner.begin(); }, compare: (unit) => { owner.compare(unit); },
  });
  const accepted = owner.toggle();
  await owner.settled;
  return { owner, failures, accepted };
}

/** Only the alert template's own re-declared icon textures (FrameXmlAchievementOwner.ts ALERT_ICON_REDECLARATION). */
function unexpectedDiagnostics(boot, from) {
  return boot.bridge.diagnostics.slice(from).map((diagnostic) => diagnostic.message)
    .filter((message) => !/^duplicate FrameXML frame name "AchievementAlertFrame\d+Icon(?:Backfill|Bling|Texture|Overlay)"/.test(message));
}

/** The shown rows of the achievement list: `label|date` per visible button. */
function achievementRows(boot) {
  return lua(boot, `
    local out = {}
    for i, button in ipairs(AchievementFrameAchievementsContainer.buttons) do
      if button:IsShown() then
        out[#out + 1] = button.label:GetText() .. "|" .. (button.dateCompleted:IsShown() and button.dateCompleted:GetText() or "")
      end
    end
    return table.concat(out, ";")`)[0].split(";");
}

/** Click the category button showing `id` (a parent is expanded first by the caller). */
function clickCategory(boot, id) {
  const clicked = lua(boot, `
    for _, button in ipairs(AchievementFrameCategoriesContainer.buttons) do
      if button:IsShown() and button.categoryID == ${id} then AchievementCategoryButton_OnClick(button) return 1 end
    end
    return 0`)[0];
  assert.equal(clicked, 1, `category ${id} has a shown button`);
}

/** Select the unearned row with this label (AchievementButton_OnClick ignoring modifiers); its id. */
function selectRow(boot, name) {
  return lua(boot, `
    for _, button in ipairs(AchievementFrameAchievementsContainer.buttons) do
      if button:IsShown() and button.label:GetText() == "${name}" and not button.completed then AchievementButton_OnClick(button, true) return button.id end
    end
    return 0`)[0];
}

test("Blizzard_AchievementUI costs nothing at boot and loads with AlertFrames.xml on the first open", withClient, async () => {
  const loaded = await load();
  const { boot, seam, requests } = loaded;
  try {
    assert.equal(boot.bridge.getFrame("AchievementFrame")?.name, undefined, "the vertical does not carry the LoD add-on");
    assert.equal(boot.bridge.getFrame("AlertFrame")?.name, undefined, "nor the toast's AlertFrames.xml");
    assert.equal(requests.some((path) => path.startsWith(ADDON_PREFIX) || ALERT_FILES.includes(path)), false,
      "no achievement file is read at boot");
    const sounds = [];
    const playSound = seam.playSound.bind(seam);
    seam.playSound = (name) => { sounds.push(name); playSound(name); };
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const started = performance.now();
    const { owner, failures, accepted } = await openWindow(loaded);
    const addonMs = performance.now() - started;
    assert.equal(accepted, true);
    assert.deepEqual(failures, []);
    assert.equal(owner.loaded, true);
    assert.deepEqual([...new Set(requests.filter((path) => path.startsWith(ADDON_PREFIX) || ALERT_FILES.includes(path)))].sort(), [
      ...ALERT_FILES,
      ...["blizzard_achievementui.lua", "blizzard_achievementui.toc", "blizzard_achievementui.xml", "localization.lua"]
        .map((file) => ADDON_PREFIX + file),
    ].sort(), "exactly the add-on's TOC closure and the two alert files");
    assert.equal(boot.errorCount, errors, `no Lua error: ${JSON.stringify(boot.errors.slice(-3))}`);
    assert.deepEqual(unexpectedDiagnostics(boot, diagnostics), []);
    assert.deepEqual(lua(boot, "return AchievementFrame:IsShown() and 1 or 0, AchievementFrameSummary:IsShown() and 1 or 0", 2), [1, 1],
      "the toggle waiting for the load opened the window on its summary");
    assert.equal(seam.achievement.owned, true);
    assert.deepEqual(sounds, ["AchievementMenuOpen"], "the silent gate played nothing; the real open played its sound");
    assert.equal(lua(boot, "return AlertFrame:IsEventRegistered('ACHIEVEMENT_EARNED') and 1 or 0")[0], 1, "the toast passed its gate");
    const widgets = lua(boot, `
      local n = 0
      local function walk(frame) n = n + 1 + select("#", frame:GetRegions())
        for _, child in ipairs({ frame:GetChildren() }) do walk(child) end end
      walk(AchievementFrame) return n`)[0];
    console.log(`[achievements] vertical boot ms ${Math.round(loaded.loadMs)}; catalog + AlertFrames + Blizzard_AchievementUI + gate + open ms ${Math.round(addonMs)}; AchievementFrame widgets ${widgets}`);
    // A second press closes it (AchievementFrame_ToggleAchievementFrame on the summary tab).
    assert.equal(owner.toggle(), true);
    assert.equal(lua(boot, "return AchievementFrame:IsShown() and 1 or 0")[0], 0);
    assert.equal(owner.isOpen(), false);
  } finally {
    boot.close();
  }
});

test("the summary: points, the earned bar, the category bars and the latest four", withClient, async () => {
  const loaded = await load();
  const { boot } = loaded;
  try {
    await openWindow(loaded);
    const errors = boot.errorCount;
    assert.equal(lua(boot, "return AchievementFrameHeaderPoints:GetText()")[0], "60",
      "seven earned: six worth 10, the feat worth 0");
    assert.equal(lua(boot, "return AchievementFrameSummaryCategoriesStatusBarText:GetText()")[0], "6/28",
      "every step of every chain outside the statistics and the feats; this Alliance character's rows only");
    assert.equal(lua(boot, "return AchievementFrameSummaryCategoriesCategory1Label:GetText() .. ' ' .. AchievementFrameSummaryCategoriesCategory1Text:GetText()")[0],
      "Общее 5/17", "General counts the whole level and gold chains");
    assert.equal(lua(boot, "return AchievementFrameSummaryCategoriesCategory6Label:GetText() .. ' ' .. AchievementFrameSummaryCategoriesCategory6Text:GetText()")[0],
      "Профессии 1/9", "Professions adds its three sub-categories");
    assert.deepEqual(lua(boot, `
      local out = {}
      for i = 1, 4 do out[i] = _G["AchievementFrameSummaryAchievement" .. i].label:GetText() .. "|" .. _G["AchievementFrameSummaryAchievement" .. i].dateCompleted:GetText() end
      return table.concat(out, ";")`)[0].split(";"),
    ["Мурчаль|9/20/26", "Повар-подмастерье|9/14/26", "Деньги-деньги, дребеденьги|9/12/26", "Можно мне его оставить?|9/07/26"],
    "the most recent first, dated with SHORTDATE (month/day/year)");
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("a category lists its earned rows first, one step per chain, this faction only", withClient, async () => {
  const loaded = await load();
  const { boot } = loaded;
  try {
    await openWindow(loaded);
    const errors = boot.errorCount;
    const categories = lua(boot, `
      local out = {}
      for _, id in ipairs(GetCategoryList()) do local name, parent = GetCategoryInfo(id) out[#out + 1] = id .. ":" .. parent end
      return table.concat(out, ",")`)[0];
    assert.equal(categories, "92:-1,170:169,14777:97,96:-1,171:169,97:-1,172:169,95:-1,168:-1,169:-1,201:-1,155:-1,81:-1",
      "by the table's UI order; the statistics root and its tree are not achievement categories");
    clickCategory(boot, 92);
    assert.deepEqual(achievementRows(boot), [
      "20-й уровень|9/03/26", "Деньги-деньги, дребеденьги|9/12/26", "Пожалуйте бриться!|9/05/26",
      "Можно мне его оставить?|9/07/26", "30-й уровень|", "Кому зуботычину?|", "Деньги-деньги, дребеденьги|",
    ], "earned first (the last earned step of each chain), then the first open step; 10-й and 40-80-й уровень are folded away");
    assert.deepEqual(lua(boot, "local n, done = GetCategoryNumAchievements(92) local all, alldone = GetCategoryNumAchievements(92, true) return n, done, all, alldone", 4),
      [8, 4, 17, 5], "eight shown (the Horde dragonhawk is not), seventeen in the chains");
    // The Incomplete filter indexes past the earned rows (AchievementFrame_GetCategoryNumAchievements_Incomplete).
    lua(boot, "AchievementFrame_SetFilter(ACHIEVEMENT_FILTER_INCOMPLETE)", 0);
    assert.deepEqual(achievementRows(boot).slice(0, 3), ["30-й уровень|", "Кому зуботычину?|", "Деньги-деньги, дребеденьги|"]);
    lua(boot, "AchievementFrame_SetFilter(ACHIEVEMENT_FILTER_ALL)", 0);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("a selected row draws its criteria: a progress bar, money, an exploration list, a meta", withClient, async () => {
  const loaded = await load();
  const { boot } = loaded;
  try {
    await openWindow(loaded);
    const errors = boot.errorCount;
    // The panes hang off the category list, not off AchievementFrame (the `$parentCategories` anchor).
    assert.deepEqual(lua(boot, `
      local out = {}
      for _, pane in ipairs({ AchievementFrameAchievements, AchievementFrameStats, AchievementFrameComparison }) do
        local point, relative, relativePoint = pane:GetPoint(1)
        out[#out + 1] = point .. ">" .. (relative and relative:GetName() or "nil") .. ":" .. relativePoint
      end
      return table.concat(out, ";")`)[0].split(";"),
    ["TOPLEFT>AchievementFrameCategories:TOPRIGHT", "TOPLEFT>AchievementFrameCategories:TOPRIGHT", "TOPLEFT>AchievementFrameCategories:TOPRIGHT"]);
    clickCategory(boot, 92);
    assert.equal(selectRow(boot, "Кому зуботычину?"), 16);
    // The selected row's objectives hang off the row's own description and icon.
    assert.equal(lua(boot, "local _, relative = AchievementFrameAchievementsObjectives:GetPoint(1) return relative and relative:GetName() or 'nil'")[0],
      lua(boot, "return AchievementFrameAchievementsObjectives:GetParent():GetName() .. 'HiddenDescription'")[0]);
    assert.deepEqual(lua(boot, "local bar = AchievementFrameProgressBar1 local low, high = bar:GetMinMaxValues() return bar:IsShown() and 1 or 0, bar.text:GetText(), bar:GetValue(), high", 4),
      [1, "150/400", 150, 400], "the unarmed-skill criterion is a progress bar (ACHIEVEMENT_CRITERIA_PROGRESS_BAR)");
    assert.equal(selectRow(boot, "Деньги-деньги, дребеденьги"), 1177);
    assert.equal(lua(boot, "return AchievementFrameProgressBar1.text:GetText()")[0], `150${GOLD} / 1000${GOLD}`,
      "a money counter reads as coins");
    // Elwynn Forest: Exploration → Eastern Kingdoms.
    clickCategory(boot, 97);
    clickCategory(boot, 14777);
    assert.equal(selectRow(boot, "Элвиннский лес"), 776);
    const criteria = lua(boot, `
      local out = {}
      for i = 1, 12 do local c = _G["AchievementFrameCriteria" .. i] out[i] = (c.check:IsShown() and "+" or "-") .. c.name:GetText() end
      return table.concat(out, ";")`)[0].split(";");
    assert.equal(criteria.length, 12);
    assert.deepEqual(criteria.filter((line) => line.startsWith("+")), ["+Долина Североземья", "+Златоземье", "+Штормград"],
      "the three explored areas are checked (EXPLORE_AREA completes at a counter of 1)");
    // The meta achievement, over three sub-categories' grandmasters.
    clickCategory(boot, 169);
    assert.equal(selectRow(boot, "На все руки мастер"), 730);
    assert.deepEqual(lua(boot, "return AchievementFrameMeta1.label:GetText(), AchievementFrameMeta2.label:GetText(), AchievementFrameMeta3.label:GetText(), AchievementFrameMeta1.check:IsShown() and 1 or 0", 4),
      ["Великий мастер рыбной ловли", "Великий мастер первой помощи", "Великий мастер кулинарии", 0]);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("statistics: a counter, a sum, money, the busiest criterion and an average with no data", withClient, async () => {
  const loaded = await load();
  const { boot } = loaded;
  try {
    await openWindow(loaded);
    const errors = boot.errorCount;
    lua(boot, "AchievementFrameTab_OnClick(2)", 0);
    const stats = lua(boot, `
      local out = {}
      for _, id in ipairs(GetStatisticsCategoryList()) do local name, parent = GetCategoryInfo(id) out[#out + 1] = id .. ":" .. parent end
      return table.concat(out, ",")`)[0];
    assert.equal(stats, "130:-1,135:128,140:130,145:130,128:-1,122:-1,133:-1",
      "the statistics tree, its top level answering parent -1");
    const rows = () => lua(boot, `
      local out = {}
      for _, button in ipairs(AchievementFrameStatsContainer.buttons) do
        if button:IsShown() and not button.isHeader then out[#out + 1] = button:GetText() .. "=" .. button.value:GetText() end
      end
      return table.concat(out, ";")`)[0].split(";");
    clickCategory(boot, 122);
    assert.deepEqual(rows(), ["Всего смертей=42"]);
    clickCategory(boot, 133);
    assert.deepEqual(rows(), ["Выполнено заданий=40", "Среднее количество заданий за день=--"],
      "the average divides by an age this client is never told; the quests sum their two criteria");
    clickCategory(boot, 128);
    clickCategory(boot, 135);
    assert.deepEqual(rows(), ["Убито существ=430"]);
    clickCategory(boot, 130);
    const character = rows();
    assert.ok(character.includes(`Всего получено золота=133${GOLD} 33${SILVER} 32${COPPER}`),
      `the income sum in coins: ${character.join(" / ")}`);
    assert.ok(character.includes("Самые часто используемые бинты=Бинты Осквернителя из магической ткани"),
      `the «most used» statistic names its busiest shared criterion: ${character.join(" / ")}`);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("an achievement earned while the window is unloaded loads it and shows the toast", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    const owner = createLazyFrameXmlAchievementOwner(seam, boot, treeRenderer());
    const errors = boot.errorCount;
    seam.achievementWorld.earn(8);
    await owner.settled;
    assert.equal(owner.loaded, true, "AlertFrame_OnEvent's AchievementFrame_LoadUI, done by the host");
    assert.deepEqual(lua(boot, "return AchievementAlertFrame1:IsShown() and 1 or 0, AchievementAlertFrame1Name:GetText(), AchievementAlertFrame1Shield.points:GetText(), AchievementFrame:IsShown() and 1 or 0", 4),
      [1, "30-й уровень", "10", 0], "the toast, and no window: nothing asked for one");
    // Another, with the add-on loaded: the second toast frame stacks above the first.
    seam.achievementWorld.earn(9);
    assert.deepEqual(lua(boot, "return AchievementAlertFrame2:IsShown() and 1 or 0, AchievementAlertFrame2Name:GetText()", 2), [1, "40-й уровень"]);
    // Someone else's achievement near the player is their chat line, not a toast.
    seam.achievementWorld.earn(10, false);
    assert.equal(lua(boot, "return AchievementAlertFrame3 and 1 or 0")[0], 0);
    // The toast opens the window on its achievement (AchievementAlertFrame_OnClick).
    lua(boot, "AchievementAlertFrame_OnClick(AchievementAlertFrame1)", 0);
    assert.deepEqual(lua(boot, "return AchievementFrame:IsShown() and 1 or 0, AchievementFrameHeaderPoints:GetText()", 2), [1, "80"]);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("tracking an achievement puts it in the WatchFrame and a criterion update redraws it", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    await openWindow(loaded);
    const errors = boot.errorCount;
    const watched = () => lua(boot, `
      local out = {}
      for i = 1, 60 do local line = _G["WatchFrameLine" .. i] if line and line:IsShown() and line.text:GetText() then out[#out + 1] = line.text:GetText() end end
      return table.concat(out, ";")`)[0];
    assert.deepEqual(lua(boot, "return AchievementButton_ToggleTracking(503) and 1 or 0, IsTrackedAchievement(503) and 1 or 0, GetNumTrackedAchievements()", 3), [1, 1, 1]);
    assert.match(watched(), /50 заданий;.*37\/50/, "the title and its progress-bar criterion's quantity string");
    seam.achievementWorld.progress(230, 38n);
    assert.match(watched(), /38\/50/, "TRACKED_ACHIEVEMENT_UPDATE for the tracked criterion redrew the line");
    // An earned achievement cannot be tracked (ERR_ACHIEVEMENT_WATCH_COMPLETED), and a second toggle untracks.
    assert.deepEqual(lua(boot, "return AchievementButton_ToggleTracking(7) and 1 or 0, IsTrackedAchievement(7) and 1 or 0", 2), [0, 0]);
    lua(boot, "AchievementButton_ToggleTracking(503)", 0);
    assert.deepEqual(lua(boot, "return GetNumTrackedAchievements(), IsTrackedAchievement(503) and 1 or 0", 2), [0, 0]);
    assert.doesNotMatch(watched(), /50 заданий/);
    // Tracked again and earned, in the core's order (the last SMSG_CRITERIA_UPDATE, then
    // SMSG_ACHIEVEMENT_EARNED): it leaves the watch list and the tracker drops its line.
    lua(boot, "AchievementButton_ToggleTracking(503)", 0);
    seam.achievementWorld.progress(230, 50n);
    assert.ok(watched().split(";").includes("50 заданий"), "still tracked: the title stays, its completed criterion is not listed");
    seam.achievementWorld.earn(503);
    assert.deepEqual(lua(boot, "return GetNumTrackedAchievements(), IsTrackedAchievement(503) and 1 or 0", 2), [0, 0]);
    assert.doesNotMatch(watched(), /50 заданий/);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("«Сравнить достижения» asks the server and fills the comparison when the answer lands", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    const { owner } = await openWindow(loaded);
    lua(boot, "HideUIPanel(AchievementFrame)", 0);
    const errors = boot.errorCount;
    lua(boot, 'InspectAchievements("party1")', 0);
    assert.deepEqual(seam.achievementWorld.inspectQueries, [0x11n], "CMSG_QUERY_INSPECT_ACHIEVEMENTS for party1's guid");
    assert.equal(lua(boot, "return GetComparisonAchievementPoints()")[0], 0, "neutral until the answer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [shown, points, name, partyName] = lua(boot,
      "return AchievementFrameComparison:IsShown() and 1 or 0, AchievementFrameComparisonHeaderPoints:GetText(), AchievementFrameComparisonHeaderName:GetText(), UnitName('party1')", 4);
    assert.deepEqual([shown, points, name], [1, "60", partyName], "INSPECT_ACHIEVEMENT_READY redrew the header");
    clickCategory(boot, 92);
    const statuses = lua(boot, `
      local out = {}
      for _, button in ipairs(AchievementFrameComparisonContainer.buttons) do
        if button:IsShown() then out[#out + 1] = button.player.label:GetText() .. "=" .. button.friend.status:GetText() end
      end
      return table.concat(out, ";")`)[0].split(";");
    assert.equal(statuses[0], "20-й уровень=7/09/26", "party1 earned level 20 on 9 July");
    assert.ok(statuses.includes(`Кому зуботычину?=${lua(boot, "return INCOMPLETE")[0]}`), statuses.join(" / "));
    // Closing the comparison clears the unit (AchievementFrameComparison_OnHide).
    lua(boot, "HideUIPanel(AchievementFrame)", 0);
    assert.equal(lua(boot, "return GetComparisonAchievementPoints()")[0], 0);
    assert.equal(owner.compare("not a unit!"), false, "only a unit token reaches the Lua");
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("stock's own ToggleAchievementFrame and AchievementFrame_LoadUI reach the host load before anything is loaded", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    const owner = createLazyFrameXmlAchievementOwner(seam, boot, treeRenderer());
    installFrameXmlAchievementHostGlobals(boot, {
      toggle: (stats) => { owner.toggle(stats); }, load: () => { owner.begin(); }, compare: (unit) => { owner.compare(unit); },
    });
    const errors = boot.errorCount;
    // UIParent.lua:351's body would call AchievementFrame_ToggleAchievementFrame, which no Lua load defines.
    lua(boot, "ToggleAchievementFrame(true)", 0);
    await owner.settled;
    assert.deepEqual(lua(boot, "return AchievementFrame:IsShown() and 1 or 0, AchievementFrame.selectedTab", 2), [1, 2],
      "the Statistics tab, as the argument asked");
    lua(boot, "HideUIPanel(AchievementFrame) AchievementFrame_LoadUI()", 0);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("without the gateway's catalog an attempt is refused and reads nothing; the next one, once it is served, opens", withClient, async () => {
  const loaded = await load({ catalog: false });
  const { boot, seam, requests, gateway } = loaded;
  try {
    const refusals = [];
    const failures = [];
    const owner = createLazyFrameXmlAchievementOwner(seam, boot, treeRenderer(), {
      onFailure: (reason) => failures.push(reason),
      onRefused: (reason, requested) => refusals.push({ reason, requested }),
    });
    installFrameXmlAchievementHostGlobals(boot, {
      toggle: (stats) => { owner.toggle(stats); }, load: () => { owner.begin(); }, compare: (unit) => { owner.compare(unit); },
    });
    const errors = boot.errorCount;
    assert.equal(owner.toggle(), true, "the first press starts the attempt");
    await owner.settled;
    assert.deepEqual(refusals, [{ reason: "achievement catalog: achievement catalog gateway returned 404", requested: true }]);
    assert.equal(owner.failed, false, "a gateway that does not serve the catalog yet is not a failure for the session");
    assert.equal(owner.loaded, false);
    assert.equal(requests.some((path) => path.startsWith(ADDON_PREFIX) || ALERT_FILES.includes(path)), false, "no add-on file was read");
    assert.equal(boot.bridge.getFrame("AchievementFrame")?.name, undefined);
    assert.equal(seam.achievement.available, true, "CanShowAchievementUI stays true: the next press asks again");
    // A toast while the catalog is still missing: refused with nobody waiting, and not replayed later.
    seam.achievementWorld.earn(8);
    await owner.settled;
    assert.deepEqual(refusals[1], { reason: "achievement catalog: achievement catalog gateway returned 404", requested: false });
    // The owner restarted the gateway: stock's own ToggleAchievementFrame loads and opens the window.
    gateway.serving = true;
    lua(boot, "ToggleAchievementFrame()", 0);
    await owner.settled;
    assert.equal(owner.loaded, true);
    assert.deepEqual(lua(boot, "return AchievementFrame:IsShown() and 1 or 0, AchievementFrameSummary:IsShown() and 1 or 0", 2), [1, 1]);
    assert.equal(lua(boot, "return AchievementAlertFrame1 and AchievementAlertFrame1:IsShown() and 1 or 0")[0], 0,
      "the toast refused earlier is not shown minutes later");
    assert.deepEqual(failures, []);
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
    assert.equal(FRAMEXML_ACHIEVEMENT_ADDON, "Blizzard_AchievementUI");
  } finally {
    boot.close();
  }
});

for (const [panel, area] of [["SpellBookFrame", "left"], ["WorldMapFrame", "fullscreen"]]) {
  test(`an achievement earned with ${panel} open loads the window without touching the open panel`, withClient, async () => {
    const loaded = await load();
    const { boot, seam } = loaded;
    try {
      const errors = boot.errorCount;
      lua(boot, `ShowUIPanel(${panel})`, 0);
      assert.equal(lua(boot, `return ${panel}:IsShown() and GetUIPanel("${area}") == ${panel} and 1 or 0`)[0], 1);
      const failures = [];
      const owner = createLazyFrameXmlAchievementOwner(seam, boot, treeRenderer(), { onFailure: (reason) => failures.push(reason) });
      seam.achievementWorld.earn(8);
      await owner.settled;
      assert.deepEqual(failures, [], "a fullscreen or centre panel does not fail the gate for the session");
      assert.equal(owner.loaded, true);
      // The gate's pass shows AchievementFrame outside UIParent's panel manager: ShowUIPanel would close a
      // left panel for the doublewide window (a quest dialog, a merchant) or refuse it under the world map.
      assert.deepEqual(lua(boot, `return ${panel}:IsShown() and 1 or 0, GetUIPanel("${area}") == ${panel} and 1 or 0, GetUIPanel("doublewide") and 1 or 0,
        AchievementAlertFrame1:IsShown() and 1 or 0, AchievementFrame:IsShown() and 1 or 0`, 5), [1, 1, 0, 1, 0],
      "the panel stays open in its slot, the toast shows, the window does not");
      assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
    } finally {
      boot.close();
    }
  });
}

test("an achievement link in chat shows its tooltip on click", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    await seam.achievement.loadCatalog();
    assert.equal(installFrameXmlAchievementLinkTooltip(boot, (guid) => seam.achievement.linkPlayer(guid)), true);
    const errors = boot.errorCount;
    // ChatFrame's OnHyperlinkClick → SetItemRef(link, text, button), which ends in ItemRefTooltip:SetHyperlink.
    const click = (text) => lua(boot, `
      SetItemRef(${JSON.stringify(/\|H([^|]+)\|h/.exec(text)[1])}, ${JSON.stringify(text)}, "LeftButton")
      local lines = {}
      for i = 1, ItemRefTooltip:NumLines() do lines[#lines + 1] = _G["ItemRefTooltipTextLeft" .. i]:GetText() end
      return ItemRefTooltip:IsShown() and 1 or 0, table.concat(lines, ";")`, 2);
    const [complete, format] = lua(boot, "return ACHIEVEMENT_TOOLTIP_COMPLETE, ACHIEVEMENT_TOOLTIP_IN_PROGRESS", 2);
    const earned = click(seam.achievement.achievementLink(7, 0x11n));
    assert.equal(earned[0], 1);
    assert.deepEqual(earned[1].split(";"), ["20-й уровень", "Достигните 20-го уровня.",
      lua(boot, `return format(ACHIEVEMENT_TOOLTIP_COMPLETE, "Альфа", 9, 3, 26)`)[0]],
    "the name, the description, and who earned it when (party1's name from the name cache)");
    assert.ok(complete.includes("%1$s"));
    const open = click(seam.achievement.achievementLink(776))[1].split(";");
    assert.equal(open[2], format.replace("%s", lua(boot, "return UnitName('player')")[0]), "this player's own link");
    assert.deepEqual(open.slice(3).filter((line) => line.startsWith("|cff00ff00")),
      ["|cff00ff00 - Долина Североземья", "|cff00ff00 - Златоземье", "|cff00ff00 - Штормград"],
      "the criteria the link's masks mark done, in the stock mini-tooltip's colours");
    assert.equal(open.length, 3 + 12);
    // An item link still reaches the widget method.
    assert.equal(click("|cffffffff|Hitem:6948:0:0:0:0:0:0:0:0|h[Камень возвращения]|h|r")[1].split(";")[0], "Камень возвращения");
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("a progress-bar achievement with hidden criteria draws one bar", withClient, async () => {
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    // «Хранитель мудрости Восточных королевств» as the dataset has it: ACHIEVEMENT_FLAG_SUMM|BAR, every
    // criterion hidden (COMPLETE_QUESTS_IN_ZONE, flags PROGRESS_BAR|HIDDEN, quantity 700); three zones here.
    const rows = JSON.parse(JSON.stringify(FRAMEXML_ACHIEVEMENT_CANNED_CATALOG));
    rows.achievements.push([1676, -1, -1, 0, "Хранитель мудрости Восточных королевств", "Выполните 700 заданий в Восточных королевствах.",
      96, 10, 2, 0x88, "Achievement_Zone_EasternKingdoms_01", "", 0, 0]);
    rows.criteria.push([90001, 1676, 11, 1, 700, "Дун Морог", 3, 0, 0, 0, 1], [90002, 1676, 11, 12, 700, "Элвиннский лес", 3, 0, 0, 0, 2],
      [90003, 1676, 11, 40, 700, "Западный Край", 3, 0, 0, 0, 3]);
    const catalog = FrameXmlAchievementCatalog.fromJson(rows);
    seam.achievement.catalogSource = { load: async () => catalog };
    seam.achievementWorld.progress(90001, 250n);
    seam.achievementWorld.progress(90002, 180n);
    await openWindow(loaded);
    const errors = boot.errorCount;
    clickCategory(boot, 96);
    assert.equal(selectRow(boot, "Хранитель мудрости Восточных королевств"), 1676);
    assert.deepEqual(lua(boot, `
      local bar = AchievementFrameProgressBar1 local low, high = bar:GetMinMaxValues()
      return GetAchievementNumCriteria(1676), bar:IsShown() and 1 or 0, bar.text:GetText(), bar:GetValue(), high, AchievementFrameCriteria1 and AchievementFrameCriteria1:IsShown() and 1 or 0`, 6),
    [1, 1, "430/700", 430, 700, 0], "the counters' sum against the criteria's quantity, and no criteria list");
    assert.equal(boot.errorCount, errors, JSON.stringify(boot.errors.slice(-3)));
  } finally {
    boot.close();
  }
});

test("a missing add-on or a failed gate leaves nothing on screen", withClient, async () => {
  const missing = await load({ missingAddon: true });
  try {
    const { owner, failures } = await openWindow(missing);
    assert.equal(owner.failed, true);
    assert.match(failures[0].reason, /Blizzard_AchievementUI/);
    assert.equal(missing.seam.achievement.owned, false);
    assert.equal(frameXmlAchievementGate({}, missing.boot, treeRenderer()), undefined, "no model, no stock window");
  } finally {
    missing.boot.close();
  }
  const loaded = await load();
  const { boot, seam } = loaded;
  try {
    // Fault injection between the load and the gate: the pass's Statistics tab raises.
    const renderer = treeRenderer();
    renderer.sync = () => lua(boot, `
      -- The pass re-points AchievementFrameTab_OnClick at the base function, as AchievementFrame_ToggleAchievementFrame does.
      local original = AchievementFrameBaseTab_OnClick
      AchievementFrameBaseTab_OnClick = function(id, ...) if id == 2 then error("injected fault") end return original(id, ...) end`, 0);
    const { owner, failures } = await openWindow(loaded, renderer);
    assert.equal(owner.failed, true);
    assert.match(failures[0].reason, /gate/);
    assert.equal(lua(boot, "return AchievementFrame:IsShown() and 1 or 0")[0], 0, "the pass's Show was undone");
    assert.equal(seam.achievement.owned, false);
  } finally {
    boot.close();
  }
});

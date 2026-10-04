import assert from "node:assert/strict";
import test, { after } from "node:test";

// This regression is MPQ-backed on purpose: the bag roots must come from the stock
// ItemButtonTemplate.xml/ContainerFrame.xml pair and their relative Lua scripts.
let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = {
  skip: clientDirectory ? false : "no 3.3.5a client on this machine",
  concurrency: false,
};
const { clientArchives } = await import("../tools/mpq.mjs");
const archiveChain = clientDirectory ? await clientArchives(clientDirectory) : undefined;
after(() => archiveChain?.close());

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const {
  FRAMEXML_TOC_PATH,
  FRAMEXML_VERTICAL_TOC,
} = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { frameXmlStubPlan } = await import("../dist/code/browser/framexml/FrameXmlStubPlan.js");
const { parseGlueToc } = await import("../dist/code/browser/glue/GlueLoader.js");

const BAG_TOC = Object.freeze([
  "MoneyFrame.lua",
  "MoneyFrame.xml",
  "ItemButtonTemplate.xml",
  "GameMenuFrame.xml",
  "ContainerFrame.xml",
  "MainMenuBarBagButtons.xml",
]);
const EXPECTED_VERTICAL_TOC = Object.freeze([
  "GlobalStrings.lua",
  "Constants.lua",
  "Fonts.xml",
  "FontStyles.xml",
  "BasicControls.xml",
  "UIParent.xml",
  "AnimTimerFrame.xml",
  "MoneyFrame.lua",
  "MoneyFrame.xml",
  "GameTooltip.xml",
  "UIDropDownMenu.xml",
  "UIPanelTemplates.lua",
  "UIPanelTemplates.xml",
  "SecureTemplates.xml",
  "SecureHandlerTemplates.xml",
  "ItemButtonTemplate.xml",
  "HybridScrollFrame.lua",
  "HybridScrollFrame.xml",
  "GameMenuFrame.xml",
  "CharacterFrameTemplates.xml",
  "TextStatusBar.lua",
  "TextStatusBar.xml",
  "AutoComplete.xml",
  "MainMenuBar.xml",
  "Minimap.xml",
  "Cooldown.xml",
  "ActionButtonTemplate.xml",
  "ActionBarFrame.xml",
  "MultiActionBars.xml",
  "BuffFrame.xml",
  // Stock TOC line 64: the hit indicator's Lua and LowHealthFrame (framexml-hud-mechanics-vertical.test.mjs).
  "CombatFeedback.xml",
  "CastingBarFrame.xml",
  "UnitFrame.xml",
  "HistoryKeeper.lua",
  "ChatFrame.xml",
  "FloatingChatFrame.xml",
  "VoiceChat.xml",
  "ReadyCheck.xml",
  "PlayerFrame.xml",
  "PartyFrame.xml",
  "TargetFrame.xml",
  // Stock TOC line 78: the totem bar PetFrame.lua's TotemFrame_Update call needs (same test).
  "TotemFrame.xml",
  "PetFrame.xml",
  "SpellBookFrame.xml",
  "CharacterFrame.xml",
  "PaperDollFrame.xml",
  "QuestFrame.xml",
  "QuestPOI.xml",
  "WatchFrame.xml",
  "QuestLogFrame.xml",
  "QuestInfo.xml",
  "ContainerFrame.xml",
  "MainMenuBarBagButtons.xml",
]);
const EXPECTED_DELTA = Object.freeze({
  files: 9,
  bytes: 95_923,
  // BankFrame.xml is now in both arms. Its ItemButtonTemplate inheritance resolves only with
  // the bag closure: BankFrame grows from 13 to 361 widgets, adding 348 to the old 5,713 delta.
  // LFDFrame.xml (both arms) adds 18 more the same way, measured: its one random-reward button,
  // LFDQueueFrameRandomScrollFrameChildFrameItem1, inherits LargeItemButtonTemplate through
  // LFDRandomDungeonLootTemplate, and that template lives in the bag closure's
  // ItemButtonTemplate.xml (LFDQueueFrameRandomScrollFrameChildFrame: 10 -> 28 widgets).
  // The window lanes then added loot, gossip, bank, taxi, friends, unit-popup, mail and trade
  // frames to both arms; their item buttons resolve through the same bag-closure templates and
  // stock UIDropDownMenu_CreateFrames grows UIDROPDOWNMENU_MAXBUTTONS for UnitPopup's long menus,
  // measured 6,079 -> 6,516. The charter windows (TabardFrame, GuildRegistrarFrame, PetitionFrame,
  // ArenaRegistrarFrame) joined both arms next; with them removed from both arms the old numbers
  // return exactly, measured 6,516 -> 6,569. PetStable.xml followed: its pet slots inherit the
  // same item-button templates (without it in both arms the delta is 6,569 again), 6,569 -> 6,595.
  widgets: 6_595,
  lua: 4,
  luaFailed: 0,
  // Seven previously absent API names remain unique to bags in the promoted full vertical.
  // The measured additions are GetCursorMoney, GetPlayerTradeMoney,
  // GetContainerNumFreeSlots, IsMacClient and TriggerTutorial, plus GetSendMailPrice and
  // GetTargetTradeMoney, which stock MoneyFrame reaches once MailFrame/TradeFrame declare
  // SEND_MAIL and TARGET_TRADE money frames. The charter windows reach one of the seven in both
  // arms, and resolve one more baseline error, leaving six and -8.
  api: 6,
  // The bag closure also resolves five baseline errors, including four occurrences of the
  // missing CONTAINER_OFFSET_X constant while UIParent lays out the incomplete baseline.
  // DurabilityFrame.xml joined both arms (3.06, 30.09): in the no-bags baseline UIParent's layout
  // reads its durabilityXOffset from the missing container offsets and raises twice more; the bag
  // closure resolves those too, measured -8/-5 -> -10/-7. The full vertical raises none of them.
  // L5c-review (04.10): VehicleMenuBar.xml joined both arms (11.02-F2, stock TOC 142). Its stock
  // VehicleSeatIndicator_OnEvent runs VehicleSeatIndicator_UnloadTextures on PLAYER_ENTERING_WORLD
  // (VehicleMenuBar.lua:962-964 → :920 UIParent_ManageFramePositions): one more layout pass, which
  // raises at UIParent.lua:1916 only in the no-bags baseline. Measured with VehicleMenuBar.xml left
  // out of both arms: -10/-7 again; with it: baseline 35 -> candidate 24, -11/-7.
  errors: -11,
  distinctErrors: -7,
});
const EXPECTED_BAG_API_SITES = Object.freeze({
  // BankFrame.lua now defines UpdateBagButtonHighlight in both arms, so its two
  // call sites are corpus-owned and no longer counted as host API dependencies.
  PlaySound: 14,
  IsModifiedClick: 11,
  GetContainerItemInfo: 9,
  // L5c-review (04.10): OpenCoinPickupFrame (6) and UpdateCoinPickupFrame (1) left this census when
  // CoinPickupFrame.xml joined the vertical (L5c 3.09, stock TOC 48): CoinPickupFrame.lua defines
  // both in both arms, so MoneyFrame.lua's call sites are corpus-owned.
  ResetCursor: 6,
  GetContainerNumSlots: 4,
  DropCursorMoney: 3,
  GetBindingKey: 3,
  PickupContainerItem: 3,
  ClearCursor: 2,
  GetCursorMoney: 2,
  GetInventoryItemTexture: 2,
  GetItemInfo: 2,
  GetPlayerTradeMoney: 2,
  GetScreenHeight: 2,
  GetScreenWidth: 2,
  ManageBackpackTokenFrame: 2,
  NotWhileDeadError: 2,
  SetBagPortraitTexture: 2,
  SplitContainerItem: 2,
  TriggerTutorial: 2,
  UnitFactionGroup: 2,
  UnitIsDead: 2,
  UseContainerItem: 2,
  AddSendMailCOD: 1,
  AddSendMailMoney: 1,
  AddTradeMoney: 1,
  BackpackTokenFrame_Update: 1,
  ContainerIDToInventoryID: 1,
  CursorHasItem: 1,
  // DressUpItemLink left the census: DressUpFrame.lua now defines it in both arms.
  GetBagName: 1,
  GetCoinText: 1,
  GetContainerItemCooldown: 1,
  GetContainerItemPurchaseInfo: 1,
  GetContainerItemPurchaseItem: 1,
  GetContainerItemQuestInfo: 1,
  GetContainerNumFreeSlots: 1,
  GetCursorInfo: 1,
  GetCVar: 1,
  GetInventoryItemLink: 1,
  GetItemQualityColor: 1,
  GetSendMailCOD: 1,
  GetSendMailMoney: 1,
  GetTargetTradeMoney: 1,
  GuildBankFrame_UpdateWithdrawMoney: 1,
  InRepairMode: 1,
  IsMacClient: 1,
  KeyRingButtonIDToInvSlotID: 1,
  Logout: 1,
  // OpenStackSplitFrame left this census when StackSplitFrame.xml joined the vertical: its
  // StackSplitFrame.lua defines the function in both arms, so the call site is corpus-owned.
  PickupBagFromSlot: 1,
  PickupGuildBankMoney: 1,
  PickupPlayerMoney: 1,
  PickupSendMailCOD: 1,
  PickupSendMailMoney: 1,
  PickupTradeMoney: 1,
  PutItemInBackpack: 1,
  PutItemInBag: 1,
  Quit: 1,
  SetPortraitToTexture: 1,
  ShowContainerSellCursor: 1,
  SocketContainerItem: 1,
  SpellCanTargetItem: 1,
  WithdrawGuildBankMoney: 1,
});
const decoder = new TextDecoder("utf-8");

function normalized(path) {
  return path.replaceAll("\\", "/").toLowerCase();
}

async function loadFromMpq(chain, subset, seam) {
  const requests = [];
  const provider = {
    async read(path) {
      requests.push(normalized(path));
      const data = await chain.read(path);
      return data ? decoder.decode(data) : undefined;
    },
  };
  const boot = new FrameXmlBoot({
    provider,
    locale: "ruRU",
    subset,
    seam,
    exercise: seam ? false : undefined,
    screen: () => ({ width: 1024, height: 768 }),
  });
  const inventory = await boot.load();
  return { boot, inventory, requests: new Set(requests) };
}

function metrics(inventory) {
  return {
    files: inventory.files.total,
    bytes: inventory.files.bytes,
    widgets: inventory.widgets.total,
    lua: inventory.lua.executed,
    luaFailed: inventory.lua.failed,
    api: inventory.api.length,
    errors: inventory.lua.errorsRaised,
    distinctErrors: inventory.errors.length,
  };
}

function installBagPanelSeams(boot) {
  // `IsOptionFrameOpen` and `updateContainerFrameAnchors` read these panel owners even though
  // this vertical intentionally does not import the full options/bank surfaces. The live mount
  // supplies the same narrow hidden host-owned proxies before its bag gate runs.
  const gameMenu = boot.bridge.getFrame("GameMenuFrame");
  assert.ok(gameMenu, "GameMenuFrame is the stock option-panel owner");
  boot.vm.setGlobal("InterfaceOptionsFrame", gameMenu);
  // `ContainerFrame_GenerateFrame` asks BankFrame:IsShown() while positioning; its hidden stock
  // GameMenu owner is the exact no-bank answer, so no synthetic visible bank panel is introduced.
  boot.vm.setGlobal("BankFrame", gameMenu);
}

function errorKey(error) {
  return `${error.file}:${error.line}:${error.message}`;
}

function subtreeSize(frame) {
  if (!frame) return 0;
  return 1 + frame.children.reduce((count, child) => count + subtreeSize(child), 0);
}

function assertOrderedSubset(actual, expected, message) {
  let cursor = -1;
  for (const entry of expected) {
    const position = actual.indexOf(entry, cursor + 1);
    assert.ok(position > cursor, `${message}: ${entry} is missing or out of order`);
    cursor = position;
  }
}

test("MPQ bags vertical loads stock item templates and concrete container roots", withClient, async () => {
  const chain = archiveChain;
  assert.ok(chain);
  let baseline;
  let candidate;
  try {
    assertOrderedSubset(FRAMEXML_VERTICAL_TOC, EXPECTED_VERTICAL_TOC,
      "the bounded vertical keeps the measured stock order while later slices may append entries");
    const toc = await chain.read(FRAMEXML_TOC_PATH);
    assert.ok(toc, "FrameXML.toc is present in the MPQ chain");
    const realEntries = parseGlueToc(decoder.decode(toc), "interface/framexml/");
    const realPaths = realEntries.map((entry) => normalized(entry.path));
    const verticalPositions = FRAMEXML_VERTICAL_TOC.map((entry) => realPaths.indexOf(
      normalized(`interface/framexml/${entry}`),
    ));
    assert.ok(verticalPositions.every((position) => position >= 0),
      `every vertical entry is in the stock TOC: ${JSON.stringify(verticalPositions)}`);
    assert.ok(verticalPositions.every((position, index) => index === 0
      || position > verticalPositions[index - 1]),
    "vertical entries preserve stock TOC order");
    assert.equal(realPaths.indexOf("interface/framexml/itembuttontemplate.xml"),
      realPaths.indexOf("interface/framexml/securehandlertemplates.xml") + 1,
    "ItemButtonTemplate.xml occupies its stock slot after SecureHandlerTemplates.xml");
    assert.equal(realPaths.indexOf("interface/framexml/moneyframe.lua"),
      realPaths.indexOf("interface/framexml/animtimerframe.xml") + 1,
    "MoneyFrame.lua occupies its stock slot after AnimTimerFrame.xml");
    assert.equal(realPaths.indexOf("interface/framexml/moneyframe.xml"),
      realPaths.indexOf("interface/framexml/moneyframe.lua") + 1,
    "MoneyFrame.xml follows MoneyFrame.lua in the stock TOC");
    assert.ok(realPaths.indexOf("interface/framexml/gamemenuframe.xml")
      > realPaths.indexOf("interface/framexml/itembuttontemplate.xml"),
    "GameMenuFrame.xml remains after ItemButtonTemplate.xml in the stock TOC");
    assert.ok(realPaths.indexOf("interface/framexml/containerframe.xml")
      > realPaths.indexOf("interface/framexml/spellbookframe.xml"),
    "ContainerFrame.xml remains after the existing SpellBookFrame tail");
    assert.ok(realPaths.indexOf("interface/framexml/mainmenubarbagbuttons.xml")
      > realPaths.indexOf("interface/framexml/containerframe.xml"),
    "MainMenuBarBagButtons.xml remains after ContainerFrame.xml in the stock TOC");

    const bagEntries = new Set(BAG_TOC.map(normalized));
    baseline = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC.filter(
      (entry) => !bagEntries.has(normalized(entry)),
    ));
    candidate = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC);

    assert.equal(baseline.boot.bridge.getFrame("ContainerFrame1")?.name, undefined,
      "the current vertical baseline has no container root");
    assert.equal(baseline.boot.bridge.registry.get("ItemButtonTemplate"), undefined,
      "the current vertical baseline has no item-button template");
    for (const entry of BAG_TOC) {
      assert.ok(candidate.requests.has(normalized(`interface/framexml/${entry}`)),
        `${entry} was read from MPQ`);
    }
    assert.ok(candidate.requests.has("interface/framexml/itembuttontemplate.lua"),
      "ItemButtonTemplate.lua was read through its relative Script");
    assert.ok(candidate.requests.has("interface/framexml/containerframe.lua"),
      "ContainerFrame.lua was read through its relative Script");
    assert.ok(candidate.requests.has("interface/framexml/mainmenubarbagbuttons.lua"),
      "MainMenuBarBagButtons.lua was read through its relative Script");
    assert.equal(candidate.inventory.files.missing.length, 0,
      "bags vertical has no missing files");
    assert.equal(candidate.inventory.xml.failed.length, 0,
      "bag XML parses without refusal");
    assert.equal(candidate.inventory.lua.failed, 0,
      "bag Lua executes successfully");
    assert.equal(candidate.inventory.xml.unknownDeclarations.length, 0,
      "bag XML adds no unknown declarations");
    assert.ok(candidate.inventory.widgets.total > baseline.inventory.widgets.total,
      "bag closure adds widgets to the current vertical without pinning an obsolete total");
    assert.ok(candidate.inventory.widgets.roots >= baseline.inventory.widgets.roots,
      "bag closure does not remove existing roots");
    assert.ok(candidate.inventory.widgets.named >= baseline.inventory.widgets.named,
      "bag closure does not remove existing named widgets");
    assert.ok(candidate.inventory.widgets.templates >= baseline.inventory.widgets.templates,
      "bag closure does not remove existing templates");

    for (const name of [
      "ContainerFrame1",
      "ContainerFrame2",
      "ContainerFrame13",
      "ContainerFrame1Item1",
      "ContainerFrame1Item36",
      "ContainerFrame13Item1",
      "ContainerFrame13Item36",
    ]) {
      assert.ok(candidate.boot.bridge.getFrame(name), `${name} exists in the MPQ candidate`);
    }
    assert.equal(candidate.boot.bridge.getFrame("ContainerFrame1")?.type, "Frame");
    assert.equal(candidate.boot.bridge.getFrame("ContainerFrame1Item1")?.type, "Button");
    const containerRoot = candidate.boot.bridge.getFrame("ContainerFrame1");
    assert.equal(containerRoot?.attributes.enableMouse, "true");
    assert.equal(containerRoot?.visible, false);
    assert.equal(candidate.boot.bridge.Show(containerRoot), true,
      "the stock container root can be shown through the bridge");
    assert.equal(containerRoot?.visible, true);
    assert.equal(candidate.boot.bridge.Hide(containerRoot), true,
      "the stock container root can be hidden through the bridge");
    assert.equal(containerRoot?.visible, false);
    for (const name of [
      "ItemButtonTemplate",
      "SimplePopupButtonTemplate",
      "PopupButtonTemplate",
      "LargeItemButtonTemplate",
      "ContainerFrameItemButtonTemplate",
      "ContainerFrameTemplate",
    ]) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template exists`);
    }

    const before = metrics(baseline.inventory);
    const after = metrics(candidate.inventory);
    const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
    assert.deepEqual(delta, EXPECTED_DELTA,
      `exact bags dependency-closure delta versus the current vertical: ${JSON.stringify(delta)}`);
    assert.equal(subtreeSize(candidate.boot.bridge.getFrame("BankFrame"))
      - subtreeSize(baseline.boot.bridge.getFrame("BankFrame")), 348,
    "the extra bag widgets are BankFrame's item slots inheriting the newly available template");

    // The static plan is the host API census for this stock bag closure. Compare it to the
    // no-bags baseline so inherited action-bar calls do not get mistaken for bag dependencies.
    const candidatePlan = frameXmlStubPlan(
      (await candidate.boot.corpus.scan(candidate.inventory.toc)).chunks,
    );
    const baselinePlan = frameXmlStubPlan(
      (await baseline.boot.corpus.scan(baseline.inventory.toc)).chunks,
    );
    const apiNames = new Set([
      ...baselinePlan.apiCallSites.keys(),
      ...candidatePlan.apiCallSites.keys(),
    ]);
    const bagApiSites = Object.fromEntries([...apiNames]
      .map((name) => [name, (candidatePlan.apiCallSites.get(name) ?? 0)
        - (baselinePlan.apiCallSites.get(name) ?? 0)])
      .filter(([, sites]) => sites > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
    assert.deepEqual(
      bagApiSites,
      EXPECTED_BAG_API_SITES,
      "the bag closure contributes the measured host API census",
    );

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateErrors = new Set(candidate.inventory.errors.map(errorKey));
    const clearedErrors = baseline.inventory.errors
      .filter((error) => !candidateErrors.has(errorKey(error)))
      .map((error) => [error.file, error.line, error.count])
      .sort((left, right) => left[0].localeCompare(right[0]) || left[1] - right[1]);
    assert.deepEqual(clearedErrors, [
      ["interface/framexml/mainmenubarmicrobuttons.lua", 39, 2],
      ["interface/framexml/paperdollframe.lua", 2161, 1],
      ["interface/framexml/paperdollframe.lua", 2335, 1],
      // DurabilityFrame.xml (3.06, 30.09): the no-bags baseline's durabilityXOffset starts from the
      // missing CONTAINER_OFFSET_X (UIParent.lua:1914, :1916), cleared by the same closure.
      ["interface/framexml/uiparent.lua", 1914, 2],
      // L5c-review (04.10): the third :1916 pass is VehicleSeatIndicator_UnloadTextures on
      // PLAYER_ENTERING_WORLD (VehicleMenuBar.xml, 11.02-F2; see EXPECTED_DELTA.errors).
      ["interface/framexml/uiparent.lua", 1916, 3],
      // Two of the four :1937 passes now stop earlier, at :1914/:1916.
      ["interface/framexml/uiparent.lua", 1937, 2],
      ["interface/framexml/voicechat.lua", 236, 1],
      // MailFrame.xml's lock overlay anchors to SendMailAttachment1, an ItemButtonTemplate
      // button whose template lives in this closure's ItemButtonTemplate.xml.
      ["SendMailFrameLockSendMail:OnLoad", 2, 1],
    ], "the bag closure clears the exact eight missing-dependency errors");
    const candidateSpecificErrors = candidate.inventory.errors.filter(
      (error) => !baselineErrors.has(errorKey(error)),
    );
    const candidateSpecificUnhandled = candidateSpecificErrors.filter((error) => !error.handled);
    assert.ok(candidateSpecificErrors.every((error) => error.handled),
      `bag closure candidate-specific errors are handled: ${JSON.stringify(candidateSpecificErrors)}`);
    assert.deepEqual(candidateSpecificUnhandled, [],
      "bags add no candidate-specific unhandled Lua errors");

    console.log(`[framexml bags] MPQ delta ${JSON.stringify({
      toc: BAG_TOC,
      baseline: before,
      candidate: after,
      delta,
      candidateSpecificErrors,
      candidateSpecificUnhandled,
    })}`);
  } finally {
    candidate?.boot.close();
    baseline?.boot.close();
  }
});

test("stock backpack click opens, refreshes, and closes the ContainerFrame seam", withClient, async () => {
  const chain = archiveChain;
  assert.ok(chain);
  let candidate;
  const seam = new CannedWorldSeam();
  try {
    candidate = await loadFromMpq(chain, FRAMEXML_VERTICAL_TOC, seam);
    const backpack = candidate.boot.bridge.getFrame("MainMenuBarBackpackButton");
    const container = candidate.boot.bridge.getFrame("ContainerFrame1");
    assert.ok(backpack, "stock MainMenuBarBackpackButton is present");
    assert.ok(container, "stock ContainerFrame1 is present");
    assert.equal(container.visible, false);
    installBagPanelSeams(candidate.boot);
    const diagnosticsBefore = candidate.boot.bridge.diagnostics.length;
    const errorsBefore = candidate.boot.vm.errors.length;

    assert.equal(candidate.boot.bridge.Click(backpack, "LeftButton", false), true,
      "the stock backpack click dispatches");
    assert.equal(container.visible, true,
      "the stock click opens ContainerFrame1 through ToggleBackpack");
    assert.equal(backpack.checked, true, "ContainerFrame_OnShow checks the stock backpack button");
    const icon = candidate.boot.bridge.getFrame("ContainerFrame1Item16IconTexture");
    const count = candidate.boot.bridge.getFrame("ContainerFrame1Item16Count");
    assert.equal(icon?.texture, "Interface\\Icons\\INV_Potion_54",
      "the CannedWorldSeam item reaches the reversed stock slot");
    assert.equal(count?.text, "5", "the stock item count reaches the item widget");

    // The live bank route begins at this exact MPQ OnClick, not at the native tooltip layer.
    // Keep the cursor operation observable without changing the fixture's item fields.
    const pickups = [];
    seam.pickupContainerItem = (bag, slot) => pickups.push([bag, slot]);
    const itemButton = candidate.boot.bridge.getFrame("ContainerFrame1Item16");
    assert.ok(itemButton);
    const stackSplit = candidate.boot.bridge.getFrame("StackSplitFrame");
    if (!stackSplit) candidate.boot.vm.setGlobal("StackSplitFrame", candidate.boot.bridge.getFrame("GameMenuFrame"));
    assert.equal(candidate.boot.bridge.Click(itemButton, "LeftButton", false), true,
      "stock item left click dispatches through ContainerFrameItemButton_OnClick");
    assert.deepEqual(pickups, [[0, 1]], "stock Lua calls PickupContainerItem with a one-based slot");
    assert.equal(candidate.boot.vm.errors.length, errorsBefore,
      "stock pickup has no unhandled Lua error");

    seam.setContainerItem(0, 1, {
      entry: 13446,
      texture: "Interface\\Icons\\INV_Potion_54",
      count: 7,
      quality: 1,
    });
    assert.equal(count?.text, "7", "BAG_UPDATE refreshes the visible stock item widget");
    assert.equal(candidate.boot.bridge.diagnostics.length, diagnosticsBefore,
      "the stock click adds no bridge diagnostics");
    assert.equal(candidate.boot.vm.errors.length, errorsBefore,
      "the stock click adds no unhandled Lua errors");

    const carriedButton = candidate.boot.bridge.getFrame("CharacterBag0Slot");
    const carriedContainer = candidate.boot.bridge.getFrame("ContainerFrame2");
    assert.ok(carriedButton, "stock CharacterBag0Slot is present");
    assert.ok(carriedContainer, "stock ContainerFrame2 is present");
    // Plan 1.15: SetBagPortraitTexture (ContainerFrame.lua:507) draws bag 1's item icon, inventory
    // slot 20, into the frame's round portrait; the backpack's portrait is not the bag icon.
    const bagIcon = "Interface\\Icons\\INV_Misc_Bag_08";
    seam.setInventoryItem(20, { entry: 4496, texture: bagIcon, count: 1, quality: 1 });
    assert.notEqual(candidate.boot.bridge.getFrame("ContainerFrame1Portrait")?.texture, bagIcon);
    assert.equal(candidate.boot.bridge.Click(carriedButton, "LeftButton", false), true,
      "the stock carried-bag click dispatches");
    assert.equal(carriedContainer.visible, true,
      "the stock carried-bag click opens ContainerFrame2 through ToggleBag");
    assert.equal(carriedButton.checked, true, "the carried-bag frame checks its stock button");
    const carriedPortrait = candidate.boot.bridge.getFrame("ContainerFrame2Portrait");
    assert.equal(carriedPortrait?.texture, bagIcon, "the bag's icon is the container's portrait");
    assert.equal(carriedPortrait?.portrait, true, "drawn as a round portrait (SetPortraitToTexture)");
    const carriedIcon = candidate.boot.bridge.getFrame("ContainerFrame2Item4IconTexture");
    const carriedCount = candidate.boot.bridge.getFrame("ContainerFrame2Item4Count");
    assert.equal(carriedIcon?.texture, "Interface\\Icons\\INV_Potion_54",
      "the carried-bag seam item reaches the reversed stock slot");
    assert.equal(carriedCount?.text, "", "the single carried-bag item hides its stock count");
    assert.equal(candidate.boot.bridge.Click(carriedButton, "LeftButton", false), true,
      "the second carried-bag click dispatches");
    assert.equal(carriedContainer.visible, false, "the carried-bag click closes ContainerFrame2");
    assert.equal(carriedButton.checked, false, "the carried-bag button unchecks on close");

    assert.equal(candidate.boot.bridge.Click(backpack, "LeftButton", false), true,
      "the second stock click dispatches");
    assert.equal(container.visible, false, "the stock backpack click closes ContainerFrame1");
    assert.equal(backpack.checked, false, "ContainerFrame_OnHide unchecks the stock button");
    assert.equal(candidate.boot.bridge.diagnostics.length, diagnosticsBefore,
      "close adds no bridge diagnostics");
    assert.equal(candidate.boot.vm.errors.length, errorsBefore,
      "close adds no unhandled Lua errors");
  } finally {
    candidate?.boot.close();
  }
});

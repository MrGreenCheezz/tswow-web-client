import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const CHAT_TOC_ENTRIES = Object.freeze([
  "AutoComplete.xml",
  "HistoryKeeper.lua",
  "ChatFrame.xml",
  "FloatingChatFrame.xml",
]);
const BASE_VERTICAL_TOC = Object.freeze(
  FRAMEXML_VERTICAL_TOC.filter((entry) => !CHAT_TOC_ENTRIES.includes(entry)),
);

let sharedChain;
async function corpusProvider() {
  if (!sharedChain) {
    const { clientArchives } = await import("../tools/mpq.mjs");
    sharedChain = await clientArchives(clientDirectory);
  }
  const decoder = new TextDecoder("utf-8");
  return {
    async read(path) {
      const data = await sharedChain.read(path.replaceAll("/", "\\"));
      return data ? decoder.decode(data) : undefined;
    },
  };
}

function chatVerticalToc() {
  // The production constant is itself the real FrameXML.toc order:
  // AutoComplete follows TextStatusBar, while the history/chat/floating files sit
  // between UnitFrame and PlayerFrame in patch-ruRU-A.MPQ's TOC. SpellBookFrame and the
  // bag closure remain in both the baseline and candidate census.
  return [...FRAMEXML_VERTICAL_TOC];
}

const EXPECTED_CHAT_TOC = Object.freeze([
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

function errorKey(error) {
  return `${error.file}:${error.line}:${error.message}`;
}

function assertOrderedSubset(actual, expected, message) {
  let cursor = -1;
  for (const entry of expected) {
    const position = actual.indexOf(entry, cursor + 1);
    assert.ok(position > cursor, `${message}: ${entry} is missing or out of order`);
    cursor = position;
  }
}

async function loadBoot(provider, subset) {
  // This census deliberately has no world seam: CannedWorldSeam's initial aura/action events
  // create ten dynamic widgets, which belongs to the integration test rather than the static TOC
  // delta measured here.
  const boot = new FrameXmlBoot({ provider, subset });
  try {
    return { boot, inventory: await boot.load() };
  } catch (error) {
    boot.close();
    throw error;
  }
}

test("MPQ ChatFrame vertical: stock concrete chat frames stay error-free", withClient, async () => {
  const provider = await corpusProvider();
  const baseline = await loadBoot(provider, BASE_VERTICAL_TOC);
  const candidate = await loadBoot(provider, chatVerticalToc());
  try {
    assertOrderedSubset(chatVerticalToc(), EXPECTED_CHAT_TOC,
      "the current vertical retains the measured stock chat order while later slices may append entries");
    assert.ok(candidate.inventory.files.total > baseline.inventory.files.total,
      "the chat closure adds files to the current vertical");
    assert.ok(candidate.inventory.files.bytes > baseline.inventory.files.bytes,
      'the chat closure adds source bytes to the current vertical');
    assert.ok(candidate.inventory.widgets.total > baseline.inventory.widgets.total,
      "the chat closure adds widgets to the current vertical");
    assert.ok(candidate.inventory.widgets.roots >= baseline.inventory.widgets.roots,
      "the chat closure does not remove existing roots");
    assert.ok(candidate.inventory.widgets.named >= baseline.inventory.widgets.named,
      "the chat closure does not remove existing named widgets");
    assert.ok(candidate.inventory.widgets.templates >= baseline.inventory.widgets.templates,
      "the chat closure does not remove existing templates");
    assert.equal(candidate.inventory.lua.failed, 0);
    assert.deepEqual(candidate.inventory.xml.failed, []);

    assert.deepEqual(
      {
        files: candidate.inventory.files.total - baseline.inventory.files.total,
        bytes: candidate.inventory.files.bytes - baseline.inventory.files.bytes,
        widgets: candidate.inventory.widgets.total - baseline.inventory.widgets.total,
        lua: candidate.inventory.lua.executed - baseline.inventory.lua.executed,
      },
        // UIMenu.xml is a real ChatMenu dependency. Its concrete menu templates add 260 stock
        // widgets to the chat delta once the missing owner is present.
        { files: 7, bytes: 276_064, widgets: 1_158, lua: 5 },
    );

    assert.ok(candidate.boot.bridge.getFrame("ChatFrame1"));
    assert.equal(candidate.boot.bridge.getFrame("ChatFrame1")?.type, "ScrollingMessageFrame");
    assert.ok(candidate.boot.bridge.getFrame("ChatFrame1EditBox"));
    assert.equal(candidate.boot.bridge.getFrame("ChatFrame1EditBox")?.type, "EditBox");
    assert.ok(candidate.boot.bridge.getFrame("FriendsMicroButtonCount"),
      "lowercase <Fontstring> still creates the concrete FriendsMicroButtonCount widget");
    for (const name of [
      "ChatFrameTemplate",
      "ChatFrameEditBoxTemplate",
      "FloatingChatFrameTemplate",
      "ChatTabTemplate",
      "AutoCompleteEditBoxTemplate",
      "AutoCompleteButtonTemplate",
    ]) {
      assert.ok(candidate.boot.bridge.registry.get(name), `${name} template is present`);
    }

    const api = new Map(candidate.inventory.api.map((entry) => [entry.name, entry]));
    for (const name of ["BNGetNumFriends", "GetNumFriends"]) {
      assert.deepEqual(
        { calls: api.get(name)?.calls, neutral: api.get(name)?.neutral },
        { calls: 1, neutral: "0, 0" },
        `${name} is answered as an empty online-count tuple`,
      );
    }

    const baselineErrors = new Set(baseline.inventory.errors.map(errorKey));
    const candidateOnlyErrors = candidate.inventory.errors
      .filter((error) => !baselineErrors.has(errorKey(error)))
      .map(errorKey);
    assert.deepEqual(candidateOnlyErrors, []);
  } finally {
    baseline.boot.close();
    candidate.boot.close();
  }
});

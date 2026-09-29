import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try { ({ clientDirectory } = await import("../tools/paths.mjs")); clientDirectory = clientDirectory(); }
catch { clientDirectory = undefined; }

function fakeDocument() {
  const doc = { createElement: (tag) => make(tag), createElementNS: (_ns, tag) => make(tag) };
  function make(tag) {
    const attributes = new Map();
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [],
      parentElement: undefined, dataset: {}, hidden: false, className: "", textContent: "",
      value: "", disabled: false, classList: { add() {}, remove() {} },
      style: { setProperty(name, value) { this[name] = String(value); },
        removeProperty(name) { delete this[name]; } },
      addEventListener() {}, removeEventListener() {},
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      removeAttribute(name) { attributes.delete(String(name)); },
      append(...children) { for (const child of children) {
        child.parentElement?.removeChild(child); child.parentElement = node; node.children.push(child);
      } },
      insertBefore(child, reference) {
        child.parentElement?.removeChild(child); child.parentElement = node;
        const index = node.children.indexOf(reference);
        if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        if (child.parentElement === node) child.parentElement = undefined;
      },
      remove() { node.parentElement?.removeChild(node); },
    };
    return node;
  }
  doc.head = make("head");
  return doc;
}

const rewardFields = {
  choices: [], items: [], money: 0, requiredMoney: 0, xpDifficulty: 0, honor: 0,
  displaySpell: 0, spell: 0, titleId: 0, talents: 0, arenaPoints: 0,
};

test("selected MPQ QuestFrame renders all four packet pages and closes without a second cancel", {
  skip: clientDirectory ? false : "selected 3.3.5a client unavailable",
}, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
  const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
  const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
  const { FrameXmlDomRenderer } = await import(
    "../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js"
  );
  const { frameXmlQuestGiverRead } = await import(
    "../dist/code/browser/framexml/FrameXmlQuestGiverAdapter.js"
  );
  const { createFrameXmlQuestGiverMountOwner } = await import(
    "../dist/code/browser/framexml/FrameXmlQuestGiverMount.js"
  );
  const { publishFrameXmlQuestGiver, notifyFrameXmlQuestGiver,
    notifyFrameXmlQuestGiverItemUpdate, closeFrameXmlQuestGiver } = await import(
    "../dist/code/browser/framexml/FrameXmlQuestGiverController.js"
  );
  const chain = await clientArchives(clientDirectory);
  const world = { questList: undefined, questDialog: undefined, questMessage: undefined };
  const seam = new CannedWorldSeam();
  let cancels = 0;
  let rewardCalls = 0;
  let hides = 0;
  seam.questGiverCall = (name, args) => {
    if (name === "CloseQuest") {
      cancels++;
      world.questList = undefined;
      world.questDialog = undefined;
      notifyFrameXmlQuestGiver(world);
      return [];
    }
    if (name === "GetQuestReward") { rewardCalls++; return []; }
    return frameXmlQuestGiverRead(name, args, world, {
      rewardMetadata: { item: (id) => id === 1001 ? {
        name: "Проверочная награда", texture: "Interface\\Icons\\INV_Misc_QuestionMark",
        quality: 1, isUsable: true,
      } : undefined },
    }) ?? [];
  };
  const decoder = new TextDecoder();
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const bytes = await chain.read(path);
      return bytes ? decoder.decode(bytes) : undefined; } },
    subset: FRAMEXML_VERTICAL_TOC, locale: "ruRU", seam,
    screen: () => ({ width: 1024, height: 768 }),
  });
  let renderer;
  let release;
  const priorDocument = globalThis.document;
  try {
    await boot.load();
    globalThis.document = fakeDocument();
    const quest = boot.bridge.getFrame("QuestFrame");
    const ui = boot.bridge.getFrame("UIParent");
    const roots = new Set([
      "QuestInfoFrame", "QuestInfoRewardsFrame", "QuestInfoObjectivesFrame",
      "QuestInfoRequiredMoneyFrame", "UIErrorsFrame",
    ].map((name) => boot.bridge.getFrame(name)));
    renderer = new FrameXmlDomRenderer(document.createElement("section"), {
      bridge: boot.bridge, includeCreatedRoots: false,
      frameFilter(frame) {
        if (frame === ui) return true;
        for (let current = frame; current; current = current.parent) {
          if (current === quest || roots.has(current)) return true;
        }
        return false;
      },
    });
    renderer.mount(boot.roots.filter((frame) => !frame.parent));
    const owner = createFrameXmlQuestGiverMountOwner(boot, renderer, seam, {
      world, currentWorld: () => world,
      hideNative() { hides++; }, prefetch() {}, onFailure() {},
    });
    assert.ok(owner, "the selected MPQ must pass structure and host helper gate");
    release = publishFrameXmlQuestGiver(owner);
    const panel = (name) => boot.bridge.isVisible(boot.bridge.getFrame(name));
    const setPage = (questList, questDialog) => {
      world.questList = questList;
      world.questDialog = questDialog;
      assert.equal(notifyFrameXmlQuestGiver(world), true,
        `stock Lua error: ${JSON.stringify(boot.errors.at(-1))}`);
    };
    setPage({ guid: 0x700n, greeting: "Привет", emoteDelay: 0, emote: 0,
      quests: [{ id: 42, icon: 2, level: 5, flags: 0, repeatable: false, title: "Задание" }] }, undefined);
    assert.equal(panel("QuestFrameGreetingPanel"), true);
    setPage(undefined, { kind: "details", guid: 0x700n, informGuid: 0n,
      questId: 42, title: "Задание", details: "Описание", objectives: "Цель",
      autoLaunched: false, flags: 0, suggestedPlayers: 0, rewards: { ...rewardFields } });
    assert.equal(panel("QuestFrameDetailPanel"), true);
    setPage(undefined, { kind: "request-items", guid: 0x700n, questId: 42,
      title: "Задание", text: "Принеси", flags: 0, suggestedPlayers: 0,
      requiredMoney: 0, items: [], canComplete: true });
    assert.equal(panel("QuestFrameProgressPanel"), true);
    setPage(undefined, { kind: "reward", guid: 0x700n, questId: 42,
      title: "Задание", text: "Спасибо", autoLaunched: false,
      flags: 0, suggestedPlayers: 0, rewards: { ...rewardFields,
        choices: [{ id: 1001, count: 1, displayId: 0 }] } });
    assert.equal(panel("QuestFrameRewardPanel"), true);
    assert.equal(notifyFrameXmlQuestGiverItemUpdate(world, 1), true);
    assert.equal(panel("QuestFrameRewardPanel"), true);
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("QuestFrameCompleteQuestButton")), true);
    assert.equal(rewardCalls, 0, "missing choice cannot send GetQuestReward");
    assert.equal(boot.bridge.getFrame("UIErrorsFrame").messageFrame.messages.at(-1)?.text,
      "Выберите себе награду.");
    assert.equal(boot.errors.length, 0);
    assert.equal(cancels, 0, "no choice or item refresh may cancel the page");

    world.questMessage = { text: "Сервер отклонил выбор", error: true };
    assert.equal(notifyFrameXmlQuestGiver(world), true);
    assert.equal(boot.bridge.getFrame("UIErrorsFrame").messageFrame.messages.at(-1)?.text,
      "Сервер отклонил выбор");
    world.questMessage = { text: "Задание завершено", error: false };
    setPage(undefined, undefined);
    assert.equal(cancels, 0, "server QUEST_FINISHED cannot send CMSG_CANCEL");
    assert.equal(boot.bridge.isVisible(quest), false);
    assert.equal(boot.bridge.getFrame("UIErrorsFrame").messageFrame.messages.at(-1)?.text,
      "Задание завершено");
    world.questMessage = undefined;
    setPage(undefined, { kind: "reward", guid: 0x700n, questId: 43,
      title: "Другое задание", text: "Спасибо", autoLaunched: false,
      flags: 0, suggestedPlayers: 0, rewards: { ...rewardFields } });
    assert.equal(boot.bridge.Click(boot.bridge.getFrame("QuestFrameCloseButton")), true);
    assert.equal(cancels, 1, "stock X sends one cancel");
    assert.equal(panel("QuestFrameRewardPanel"), false);

    setPage(undefined, { kind: "request-items", guid: 0x700n, questId: 44,
      title: "Третье задание", text: "Принеси", flags: 0, suggestedPlayers: 0,
      requiredMoney: 0, items: [], canComplete: true });
    assert.equal(closeFrameXmlQuestGiver(), true);
    assert.equal(cancels, 2, "Escape sends one cancel, nested FINISHED sends none");
    assert.equal(boot.bridge.isVisible(quest), false);
    setPage(undefined, { kind: "details", guid: 0x700n, informGuid: 0n,
      questId: 45, title: "Четвёртое задание", details: "Описание", objectives: "Цель",
      autoLaunched: false, flags: 0, suggestedPlayers: 0, rewards: { ...rewardFields } });
    release();
    assert.equal(cancels, 2, "forced mount teardown preserves the packet page");
    assert.ok(hides >= 7);
  } finally {
    release?.();
    renderer?.destroy();
    globalThis.document = priorDocument;
    boot.close();
    chain.close();
  }
});

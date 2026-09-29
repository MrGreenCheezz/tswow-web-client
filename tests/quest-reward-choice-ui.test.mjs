import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { buildQuestChooseReward } from "../dist/code/world/NpcProtocol.js";

function fakeDocument() {
  const byId = new Map();
  const make = (tag) => {
    const listeners = new Map();
    const attributes = new Map();
    const classes = new Set();
    const node = {
      tagName: String(tag).toUpperCase(), children: [], parentElement: undefined,
      dataset: {}, className: "", textContent: "", hidden: false, disabled: false,
      style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, force) {
          const selected = force ?? !classes.has(name);
          if (selected) classes.add(name); else classes.delete(name);
          return selected;
        },
        contains(name) { return classes.has(name); },
      },
      append(...children) { for (const child of children) { child.parentElement = node; node.children.push(child); } },
      replaceChildren(...children) { node.children = []; node.append(...children); },
      remove() {
        if (!node.parentElement) return;
        node.parentElement.children = node.parentElement.children.filter((child) => child !== node);
        node.parentElement = undefined;
      },
      addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
      click() {
        if (node.disabled) return;
        for (const listener of listeners.get("click") ?? []) listener({ type: "click", stopPropagation() {} });
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; },
      getContext() { return null; },
      querySelector() { return make("div"); }, querySelectorAll() { return []; },
    };
    return node;
  };
  return {
    createElement: make, createElementNS: (_namespace, tag) => make(tag),
    createTextNode: (value) => ({ textContent: value }), createDocumentFragment: () => make("fragment"),
    body: make("body"), documentElement: make("html"), head: make("head"),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, make("div"));
      return byId.get(id);
    },
    querySelector() { return make("div"); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

globalThis.document = fakeDocument();
globalThis.location = { protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:5173" };
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, setTimeout() {}, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 800,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
globalThis.localStorage = globalThis.window.localStorage;
globalThis.requestAnimationFrame = () => 0;
globalThis.HTMLElement = class {};

const { game } = await import("../dist/code/browser/game/Context.js");
const { showQuestState } = await import("../dist/code/browser/ui/Npc.js");
const { WorldClient } = await import("../dist/code/world/WorldClient.js");

function rewardDialog(questId, choices, requiredMoney = 0) {
  return {
    kind: "reward", guid: 0x1234n, questId, title: "Сдать задание", text: "Спасибо",
    autoLaunched: true, flags: 0, suggestedPlayers: 0,
    rewards: {
      choices: choices.map((id) => ({ id, count: 1, displayId: 0 })), items: [],
      money: 0, requiredMoney, xpDifficulty: 0, honor: 0, displaySpell: 0,
      spell: 0, titleId: 0, talents: 0, arenaPoints: 0,
    },
  };
}

function activeWorld(dialog) {
  const sent = [];
  const world = new WorldClient({ send: (opcode, payload) => sent.push({ opcode, payload }) });
  world.questDialog = dialog;
  world.itemTemplate = () => undefined;
  game.world = world;
  return { world, sent };
}

test("reward item click selects a choice and the finish button sends it once", (t) => {
  t.after(() => { game.world = undefined; });
  const dialog = rewardDialog(42, [25, 26]);
  const { world, sent } = activeWorld(dialog);
  showQuestState();
  const choices = document.getElementById("quest-rewards").children;
  const finish = document.getElementById("quest-actions").children[0];
  assert.equal(finish.disabled, true);
  choices[1].click();
  assert.deepEqual(sent, [], "selecting an item must not irrevocably reward the quest");
  assert.equal(choices[1].getAttribute("aria-pressed"), "true");
  assert.equal(finish.disabled, false);
  finish.click();
  assert.deepEqual(sent, [{ opcode: OPCODES.CMSG_QUESTGIVER_CHOOSE_REWARD,
    payload: buildQuestChooseReward(dialog.guid, dialog.questId, 1) }]);
  world.questDialog = rewardDialog(44, [27, 28]);
  showQuestState();
  assert.equal(document.getElementById("quest-actions").children[0].disabled, true,
    "a new offer cannot inherit the previous quest's selection");
  choices[0].click();
  assert.equal(sent.length, 1, "a detached reward button cannot submit the next quest");
});

test("a paid quest labels its cost and waits for confirmation before reward request", (t) => {
  t.after(() => { game.world = undefined; });
  const dialog = rewardDialog(43, [], 125);
  const { sent } = activeWorld(dialog);
  showQuestState();
  const rewards = document.getElementById("quest-rewards");
  assert.match(rewards.children.at(-1)?.textContent ?? "", /1с 25м/);
  assert.match(rewards.children.at(-1)?.textContent ?? "", /Требуется/);
  document.getElementById("quest-actions").children[0].click();
  assert.deepEqual(sent, [], "clicking Finish must offer a chance to cancel the cost");
  const confirmation = document.body.children.at(-1);
  assert.match(confirmation?.children[0]?.textContent ?? "", /Подтвердить/);
  confirmation.children.at(-1).children[0].click();
  assert.deepEqual(sent, [{ opcode: OPCODES.CMSG_QUESTGIVER_CHOOSE_REWARD,
    payload: buildQuestChooseReward(dialog.guid, dialog.questId, 0) }]);
});

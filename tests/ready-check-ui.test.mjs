import assert from "node:assert/strict";
import test from "node:test";

function element(tag = "div") {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(), id: "", className: "", children: [], hidden: false,
    textContent: "", type: "", style: {},
    classList: { add() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    setAttribute() {}, remove() {},
    click() { listeners.get("click")?.(); },
  };
}

const viewport = element();
globalThis.document = { createElement: element };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
const { game } = await import("../dist/code/browser/game/Context.js");
const { usePanelHost } = await import("../dist/code/browser/ui/Widgets.js");
const { closeReadyCheck, readyCheckOpen, showReadyCheck, updateReadyCheck } =
  await import("../dist/code/browser/ui/ReadyCheck.js");
usePanelHost({ viewport, attach() {} });

const panel = () => viewport.children.find((entry) => entry.id === "ready-check-window");
const actions = () => panel().children[1].children.find((entry) => entry.className === "ready-check-actions");
const button = (text) => actions().children.find((entry) => entry.textContent === text);

function world(startedAt, initiatorGuid = 2n) {
  const answers = [];
  return {
    readyCheck: { initiatorGuid, startedAt, answers: new Map() },
    state: { selfGuid: 1n },
    group: { leaderGuid: 2n, ownFlags: 0, ownSubGroup: 0, ownRoles: 0, members: [] },
    displayName: (guid) => `Player ${guid}`,
    answerReadyCheck: (ready) => answers.push(ready),
    answers,
  };
}

test("ready check uses the monotonic packet clock and expires after 35 seconds", () => {
  const start = performance.now() - 1_000;
  game.world = world(start);
  try {
    showReadyCheck();
    assert.equal(readyCheckOpen(), true, "a new prompt stays visible after its packet");
    assert.ok(button("Готов"), "a responder can answer");
    updateReadyCheck(start + 36_000);
    assert.equal(readyCheckOpen(), false, "the prompt closes when its deadline passes");
  } finally { closeReadyCheck(); game.world = undefined; }
});

test("answering dismisses the stock prompt until a new check starts", () => {
  const current = world(performance.now());
  game.world = current;
  try {
    showReadyCheck();
    button("Готов").click();
    assert.deepEqual(current.answers, [true]);
    assert.equal(readyCheckOpen(), false, "ReadyCheck.xml hides the frame on answer");
    current.readyCheck.answers.set(3n, false);
    showReadyCheck();
    assert.equal(readyCheckOpen(), false, "another player's answer does not reopen my prompt");
    current.readyCheck = { initiatorGuid: 2n, startedAt: performance.now(), answers: new Map() };
    showReadyCheck();
    assert.equal(readyCheckOpen(), true, "a new check has a fresh prompt");
  } finally { closeReadyCheck(); game.world = undefined; }
});

test("the responder hears one ready-check chime; the initiator has no answer buttons", () => {
  const played = [];
  game.sound = { play: (kit) => played.push(kit.name) };
  game.soundKits = { named: (name) => name === "ReadyCheck" ? 77 : undefined,
    kit: (id) => ({ id, name: "ReadyCheck" }) };
  game.world = world(performance.now());
  try {
    showReadyCheck();
    showReadyCheck();
    assert.deepEqual(played, ["ReadyCheck"], "repaints do not repeat the stock sound");
    closeReadyCheck();
    game.world = world(performance.now(), 1n);
    showReadyCheck();
    assert.equal(button("Готов"), undefined);
    assert.equal(button("Не готов"), undefined);
    assert.ok(button("Завершить"));
  } finally {
    closeReadyCheck(); game.world = undefined; game.sound = undefined; game.soundKits = undefined;
  }
});

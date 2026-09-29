import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readFile } from "node:fs/promises";

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), children: [], dataset: {},
    className: "", textContent: "", hidden: false, disabled: false,
    type: "", value: "", title: "",
    listeners: new Map(),
    append(...children) { node.children.push(...children); },
    replaceChildren(...children) { node.children = [...children]; },
    addEventListener(name, handler) { node.listeners.set(name, handler); },
    setAttribute() {},
    click() { node.listeners.get("click")?.(); },
  };
  return node;
}

globalThis.document = { createElement: (tag) => makeNode(tag) };

function allNodes(root, out = []) {
  out.push(root);
  for (const child of root.children ?? []) allNodes(child, out);
  return out;
}

class FakePanel {
  static instances = [];
  body = makeNode("div");
  visible = false;
  constructor() { FakePanel.instances.push(this); }
  show() { this.visible = true; }
  hide() { this.visible = false; }
}

async function isolatedRoster(game, chat) {
  const source = await readFile(new URL("../src/browser/ui/ChannelRoster.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const modules = {
    "../../world/ChannelProtocol.js": await import("../dist/code/world/ChannelProtocol.js"),
    "../game/Context.js": { game },
    "./ChatDock.js": { activeChannelTab: () => undefined },
    "./Chat.js": chat,
    "./Widgets.js": {
      Panel: FakePanel,
      confirmPanel: (_anchor, options) => options.onConfirm(),
    },
  };
  new Function("require", "module", "exports", js)(
    (name) => modules[name] ?? new Proxy({}, { get: () => () => {} }), module, module.exports);
  return module.exports;
}

function fakeWorld() {
  const calls = [];
  return {
    calls,
    channels: new Map([["General", {
      flags: 0,
      count: 2,
      members: [{ guid: 1n, flags: 1 }, { guid: 2n, flags: 8 }],
    }]]),
    displayName: (guid) => (guid === 1n ? "Маг" : "0x0000000000000002"),
    requestName: () => {},
    requestChannelList: (channel) => calls.push(["list", channel]),
    kickChannelMember: (channel, name) => calls.push(["kick", channel, name]),
    banChannelMember: (channel, name) => calls.push(["ban", channel, name]),
    muteChannelMember: (channel, name) => calls.push(["mute", channel, name]),
    unmuteChannelMember: (channel, name) => calls.push(["unmute", channel, name]),
    setChannelModerator: (channel, name) => calls.push(["mod", channel, name]),
    unsetChannelModerator: (channel, name) => calls.push(["unmod", channel, name]),
    toggleChannelAnnounce: (channel) => calls.push(["announce", channel]),
    leaveChannel: (channel) => calls.push(["leave", channel]),
  };
}

test("the roster lists members with flags and asks for the list", async () => {
  FakePanel.instances.length = 0;
  const world = fakeWorld();
  const roster = await isolatedRoster({ world }, { systemLine: () => {} });
  roster.openChannelRoster("General");
  assert.equal(roster.channelRosterOpen(), true);
  assert.deepEqual(world.calls, [["list", "General"]]);
  const panel = FakePanel.instances.at(-1);
  const text = allNodes(panel.body).map((node) => node.textContent).join("\n");
  assert.match(text, /Маг · владелец/, "owner flag reads in words");
  assert.match(text, /заглушен/, "mute flag reads in words");
  assert.match(text, /всего 2/, "the total count shows");
});

test("moderation buttons confirm and then send", async () => {
  FakePanel.instances.length = 0;
  const world = fakeWorld();
  const roster = await isolatedRoster({ world }, { systemLine: () => {} });
  roster.openChannelRoster("General");
  const panel = FakePanel.instances.at(-1);
  const rows = allNodes(panel.body).filter((node) => node.className === "channel-roster-row");
  // Rows sort by name, so the hex row comes first: find the mage's own row.
  const mageRow = rows.find((row) => allNodes(row).some((node) => node.textContent?.includes("Маг")));
  assert.ok(mageRow, "the mage has a row");
  const kick = allNodes(mageRow).find((node) => node.tagName === "BUTTON" && node.textContent === "Кик");
  assert.ok(kick, "a kick button is drawn");
  kick.click();
  assert.ok(world.calls.some(([action, channel, name]) =>
    action === "kick" && channel === "General" && name === "Маг"));
  const unmute = allNodes(panel.body)
    .filter((node) => node.tagName === "BUTTON" && node.textContent === "Разглушить")[0];
  assert.ok(unmute, "a muted member offers unmute, not mute");
  unmute.click();
  assert.ok(world.calls.some(([action]) => action === "unmute"));
});

test("toggle without a channel and without an active tab says how to open it", async () => {
  const lines = [];
  const world = fakeWorld();
  const roster = await isolatedRoster({ world }, { systemLine: (text) => lines.push(text) });
  roster.toggleChannelRoster();
  assert.equal(roster.channelRosterOpen(), false);
  assert.ok(lines.some((line) => line.includes("/roster")), "usage hints at /roster Название");
});
